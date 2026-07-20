/**
 * Megolm session-key export files, in the de-facto standard format used by
 * Element (`-----BEGIN MEGOLM SESSION DATA-----`), so a Crust export can be
 * imported by Element and vice versa.
 *
 * matrix-js-sdk no longer ships these helpers (MegolmExportEncryption was
 * removed with legacy crypto), so they are implemented here on WebCrypto.
 * The format (matching Element's implementation):
 *
 *   payload = version(0x01) ‖ salt(32B) ‖ iv(16B) ‖ iterations(uint32 BE) ‖ ciphertext
 *   file    = base64(payload ‖ hmac-sha256(hmacKey, payload))
 *   key     = PBKDF2(passphrase, salt, iterations, SHA-512, 512 bits)
 *             → first 32 bytes: AES-256-CTR key; last 32 bytes: HMAC key
 *
 * AES-CTR is used with a 64-bit counter; that's what Element's WebCrypto
 * implementation uses and is behaviorally identical to a full 128-bit
 * counter for any realistic file size.
 */

const HEADER = "-----BEGIN MEGOLM SESSION DATA-----";
const TRAILER = "-----END MEGOLM SESSION DATA-----";
const FORMAT_VERSION = 1;
const DEFAULT_ITERATIONS = 500_000;
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const HMAC_LENGTH = 32;

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

function uint32be(n: number): Uint8Array {
	const buf = new Uint8Array(4);
	new DataView(buf.buffer).setUint32(0, n, false);
	return buf;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function deriveKeyBits(
	passphrase: string,
	salt: Uint8Array<ArrayBuffer>,
	iterations: number,
): Promise<Uint8Array<ArrayBuffer>> {
	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(passphrase),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-512", salt, iterations },
		material,
		512,
	);
	return new Uint8Array(bits);
}

/** Whether the text looks like an encrypted megolm key export (vs raw JSON). */
export function isMegolmKeyExportFile(text: string): boolean {
	return text.trimStart().startsWith(HEADER);
}

/**
 * Encrypt exported room-key JSON into the Element-compatible export file
 * format. `iterations` is injectable for tests (production uses the
 * format's default 500k PBKDF2 rounds).
 */
export async function encryptMegolmKeyFile(
	data: string,
	passphrase: string,
	iterations = DEFAULT_ITERATIONS,
): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
	const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
	const key = await deriveKeyBits(passphrase, salt, iterations);

	const aesKey = await crypto.subtle.importKey(
		"raw",
		key.slice(0, 32),
		{ name: "AES-CTR" },
		false,
		["encrypt"],
	);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-CTR", counter: iv, length: 64 },
			aesKey,
			new TextEncoder().encode(data),
		),
	);

	const payload = concatBytes(
		new Uint8Array([FORMAT_VERSION]),
		salt,
		iv,
		uint32be(iterations),
		ciphertext,
	);
	const hmacKey = await crypto.subtle.importKey(
		"raw",
		key.slice(32, 64),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const hmac = new Uint8Array(
		await crypto.subtle.sign("HMAC", hmacKey, payload),
	);

	return `${HEADER}\n${bytesToBase64(concatBytes(payload, hmac))}\n${TRAILER}`;
}

/**
 * Decrypt an Element-compatible export file back to the room-key JSON.
 * Throws with a user-presentable message when the file is malformed, or
 * when the passphrase is wrong / the file was tampered with (HMAC
 * mismatch).
 */
export async function decryptMegolmKeyFile(
	fileText: string,
	passphrase: string,
): Promise<string> {
	const trimmed = fileText.trim();
	if (!trimmed.startsWith(HEADER) || !trimmed.endsWith(TRAILER)) {
		throw new Error("Not a megolm key export file.");
	}
	const body = trimmed
		.slice(HEADER.length, trimmed.length - TRAILER.length)
		.replace(/\s+/g, "");

	let packed: Uint8Array;
	try {
		packed = base64ToBytes(body);
	} catch {
		throw new Error("The key export file is corrupted.");
	}

	const headerLength = 1 + SALT_LENGTH + IV_LENGTH + 4;
	if (packed.length < headerLength + HMAC_LENGTH) {
		throw new Error("The key export file is corrupted.");
	}
	if (packed[0] !== FORMAT_VERSION) {
		throw new Error("Unsupported key export file version.");
	}

	const salt = packed.slice(1, 1 + SALT_LENGTH);
	const iv = packed.slice(1 + SALT_LENGTH, headerLength - 4);
	const iterations = new DataView(
		packed.buffer,
		packed.byteOffset + headerLength - 4,
		4,
	).getUint32(0, false);
	const ciphertext = packed.slice(headerLength, packed.length - HMAC_LENGTH);
	const expectedHmac = packed.slice(packed.length - HMAC_LENGTH);
	const payload = packed.slice(0, packed.length - HMAC_LENGTH);

	const key = await deriveKeyBits(passphrase, salt, iterations);
	const hmacKey = await crypto.subtle.importKey(
		"raw",
		key.slice(32, 64),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const hmacOk = await crypto.subtle.verify(
		"HMAC",
		hmacKey,
		expectedHmac,
		payload,
	);
	if (!hmacOk) {
		throw new Error("Incorrect passphrase, or the file is corrupted.");
	}

	const aesKey = await crypto.subtle.importKey(
		"raw",
		key.slice(0, 32),
		{ name: "AES-CTR" },
		false,
		["decrypt"],
	);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-CTR", counter: iv, length: 64 },
		aesKey,
		ciphertext,
	);
	return new TextDecoder().decode(plaintext);
}
