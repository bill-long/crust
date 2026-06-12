/**
 * WebCrypto AES-CTR decryption + SHA-256 verification for Matrix encrypted
 * attachments (the `content.file` / `info.thumbnail_file` EncryptedFile block).
 *
 * Matrix encrypts attachments with AES-256-CTR and stores a SHA-256 hash of
 * the *ciphertext* alongside the key, so a client can detect tampering before
 * trusting the plaintext. We verify that hash first and fail closed on any
 * mismatch — a garbled or substituted file never renders.
 *
 * matrix-js-sdk does not bundle attachment crypto and there is no
 * `matrix-encrypt-attachment` dependency, so this is the project's own
 * implementation. Phase 4 (encrypt on send) reuses the base64 helpers and the
 * EncryptedFileInfo shape here.
 *
 * @see https://spec.matrix.org/v1.11/client-server-api/#sending-encrypted-attachments
 */

/**
 * The subset of a Matrix `EncryptedFile` we need to download and decrypt an
 * attachment. Validated at runtime by {@link parseEncryptedFile} since it
 * arrives as untrusted event content.
 */
export interface EncryptedFileInfo {
	/** mxc:// URI of the ciphertext. */
	url: string;
	/** JWK; only the raw key material `k` (base64url) is needed for AES-CTR. */
	key: { k: string };
	/** 16-byte AES-CTR initial counter block, base64. */
	iv: string;
	/** Ciphertext hashes; the SHA-256 entry is required and verified. */
	hashes: { sha256: string };
	/** Protocol version (`"v2"`). */
	v?: string;
}

/**
 * Decode base64 tolerantly: accepts the URL-safe alphabet (`-_`) and missing
 * padding, since Matrix uses unpadded base64 for `iv`/`hashes` and base64url
 * for the JWK key.
 */
function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
	let b64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const remainder = b64.length % 4;
	if (remainder === 2) b64 += "==";
	else if (remainder === 3) b64 += "=";
	else if (remainder === 1) throw new Error("Invalid base64 length");
	const binary = atob(b64);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * True when `value` is base64 (any alphabet/padding) that decodes to exactly
 * `bytes` bytes. Caps the input length first so a pathological/huge string from
 * untrusted event content can't drive a large `atob()` allocation.
 */
function isBase64OfLength(value: string, bytes: number): boolean {
	const maxChars = Math.ceil(bytes / 3) * 4 + 4;
	if (value.length === 0 || value.length > maxChars) return false;
	try {
		return decodeBase64(value).length === bytes;
	} catch {
		return false;
	}
}

/** Encode bytes as standard, unpadded base64 (Matrix's hash encoding). */
function encodeBase64Unpadded(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary).replace(/=+$/, "");
}

/**
 * Validate untrusted event content into an {@link EncryptedFileInfo}, or null
 * if it isn't a usable encrypted file (missing url/key/iv/hash). Returning null
 * (rather than throwing) lets the projection treat malformed files as "no
 * image" instead of crashing the timeline.
 */
export function parseEncryptedFile(value: unknown): EncryptedFileInfo | null {
	if (!value || typeof value !== "object") return null;
	const file = value as Record<string, unknown>;
	const { url, iv, v } = file;
	const key = file.key as Record<string, unknown> | undefined;
	const hashes = file.hashes as Record<string, unknown> | undefined;
	if (typeof url !== "string" || url.length === 0) return null;
	// Reject explicitly-unsupported protocol versions (the spec requires "v2");
	// tolerate an absent `v` for older content.
	if (typeof v === "string" && v !== "v2") return null;
	if (!key || typeof key.k !== "string") return null;
	if (typeof iv !== "string") return null;
	if (!hashes || typeof hashes.sha256 !== "string") return null;
	// Validate that the crypto material decodes to the sizes AES-256-CTR /
	// SHA-256 require (key 32B, IV 16B, hash 32B). Doing it here means malformed
	// or oversized untrusted event content fails closed *before* a wasted fetch
	// and decrypt, rather than only throwing inside decryptAttachment.
	if (!isBase64OfLength(key.k, 32)) return null;
	if (!isBase64OfLength(iv, 16)) return null;
	if (!isBase64OfLength(hashes.sha256, 32)) return null;
	return {
		url,
		key: { k: key.k },
		iv,
		hashes: { sha256: hashes.sha256 },
		v: typeof v === "string" ? v : undefined,
	};
}

/**
 * Verify the ciphertext's SHA-256 hash, then AES-256-CTR decrypt it. Throws
 * (fails closed) when the hash doesn't match, so callers never render a
 * tampered or corrupted attachment.
 *
 * @param ciphertext the downloaded encrypted bytes
 * @param file the validated EncryptedFile descriptor
 * @returns the decrypted plaintext bytes
 */
export async function decryptAttachment(
	ciphertext: ArrayBuffer,
	file: EncryptedFileInfo,
): Promise<ArrayBuffer> {
	const expected = file.hashes.sha256;
	if (typeof expected !== "string" || expected.length === 0) {
		throw new Error("Encrypted attachment is missing its SHA-256 hash");
	}
	// Hash-check the ciphertext *before* decrypting — fail closed on mismatch.
	const digest = await crypto.subtle.digest("SHA-256", ciphertext);
	const actual = encodeBase64Unpadded(new Uint8Array(digest));
	// Normalize the expected hash through decode→encode so padding/alphabet
	// differences don't cause a false mismatch.
	const expectedNormalized = encodeBase64Unpadded(decodeBase64(expected));
	if (actual !== expectedNormalized) {
		throw new Error("Encrypted attachment hash mismatch");
	}

	const keyBytes = decodeBase64(file.key.k);
	const counter = decodeBase64(file.iv);
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "AES-CTR" },
		false,
		["decrypt"],
	);
	// Matrix uses the full 16-byte IV as the initial counter block with a
	// 64-bit counter (the high 64 bits are the nonce).
	return crypto.subtle.decrypt(
		{ name: "AES-CTR", counter, length: 64 },
		cryptoKey,
		ciphertext,
	);
}
