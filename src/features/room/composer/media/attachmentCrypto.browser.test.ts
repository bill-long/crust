/**
 * Browser-mode tests for attachment decryption. Runs in Chromium because it
 * exercises real WebCrypto (AES-CTR + SHA-256). The test encrypts with
 * WebCrypto the same way Matrix does, then asserts the helper round-trips and
 * fails closed on tampering.
 */

import { describe, expect, it } from "vitest";
import {
	decryptAttachment,
	type EncryptedFileInfo,
	encryptAttachment,
	parseEncryptedFile,
} from "./attachmentCrypto";

function bytesToBase64Unpadded(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++)
		binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/=+$/, "");
}

function bytesToBase64Url(bytes: Uint8Array): string {
	return bytesToBase64Unpadded(bytes).replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Encrypt plaintext exactly as a Matrix client would, returning the descriptor.
 * Independent of our own {@link encryptAttachment} so the decrypt tests below
 * exercise the read path against a reference encryptor, not our encoder.
 */
async function encryptLikeMatrix(
	plaintext: Uint8Array,
): Promise<{ file: EncryptedFileInfo; ciphertext: ArrayBuffer }> {
	const keyBytes = crypto.getRandomValues(new Uint8Array(32));
	// 16-byte counter block: first 8 bytes random nonce, low 8 bytes zero.
	const counter = new Uint8Array(16);
	counter.set(crypto.getRandomValues(new Uint8Array(8)), 0);
	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "AES-CTR" },
		false,
		["encrypt"],
	);
	// Normalize into an ArrayBuffer-backed view for WebCrypto's strict typing.
	const data = new Uint8Array(new ArrayBuffer(plaintext.byteLength));
	data.set(plaintext);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-CTR", counter, length: 64 },
		key,
		data,
	);
	const digest = await crypto.subtle.digest("SHA-256", ciphertext);
	const file: EncryptedFileInfo = {
		url: "mxc://example.com/ciphertext",
		key: { k: bytesToBase64Url(keyBytes) },
		iv: bytesToBase64Unpadded(counter),
		hashes: { sha256: bytesToBase64Unpadded(new Uint8Array(digest)) },
		v: "v2",
	};
	return { file, ciphertext };
}

describe("decryptAttachment", () => {
	it("round-trips AES-CTR ciphertext back to the original plaintext", async () => {
		const plaintext = new TextEncoder().encode("the quick brown fox 🦊");
		const { file, ciphertext } = await encryptLikeMatrix(plaintext);

		const decrypted = await decryptAttachment(ciphertext, file);
		expect(new Uint8Array(decrypted)).toEqual(plaintext);
	});

	it("fails closed when the declared hash doesn't match the ciphertext", async () => {
		const { file, ciphertext } = await encryptLikeMatrix(
			new Uint8Array([1, 2, 3, 4, 5]),
		);
		const tampered: EncryptedFileInfo = {
			...file,
			hashes: { sha256: bytesToBase64Unpadded(new Uint8Array(32)) },
		};
		await expect(decryptAttachment(ciphertext, tampered)).rejects.toThrow(
			/hash mismatch/i,
		);
	});

	it("fails closed when the ciphertext bytes are tampered", async () => {
		const { file, ciphertext } = await encryptLikeMatrix(
			new Uint8Array([9, 8, 7, 6]),
		);
		const corrupted = ciphertext.slice(0);
		new Uint8Array(corrupted)[0] ^= 0xff;
		await expect(decryptAttachment(corrupted, file)).rejects.toThrow(
			/hash mismatch/i,
		);
	});
});

describe("parseEncryptedFile", () => {
	// base64 that decodes to the required sizes: 32-byte key, 16-byte IV,
	// 32-byte SHA-256.
	const KEY32 = "A".repeat(43);
	const HASH32 = "A".repeat(43);
	const IV16 = "AAAAAAAAAAAAAAAAAAAAAA==";
	const valid = {
		url: "mxc://example.com/x",
		key: { k: KEY32 },
		iv: IV16,
		hashes: { sha256: HASH32 },
		v: "v2",
	};

	it("accepts a well-formed encrypted file", () => {
		expect(parseEncryptedFile(valid)).toEqual({
			url: "mxc://example.com/x",
			key: { k: KEY32 },
			iv: IV16,
			hashes: { sha256: HASH32 },
			v: "v2",
		});
	});

	it("rejects missing key material, iv, hash, or url", () => {
		expect(parseEncryptedFile(null)).toBeNull();
		expect(parseEncryptedFile({ ...valid, url: "" })).toBeNull();
		expect(parseEncryptedFile({ ...valid, key: {} })).toBeNull();
		expect(parseEncryptedFile({ ...valid, iv: "" })).toBeNull();
		expect(parseEncryptedFile({ ...valid, hashes: {} })).toBeNull();
	});

	it("rejects wrong-size / non-base64 crypto material up front", () => {
		// Key/IV/hash that decode to the wrong byte length.
		expect(parseEncryptedFile({ ...valid, key: { k: "AAAA" } })).toBeNull();
		expect(parseEncryptedFile({ ...valid, iv: "AAAA" })).toBeNull();
		expect(
			parseEncryptedFile({ ...valid, hashes: { sha256: "AAAA" } }),
		).toBeNull();
		// Not decodable base64 at all.
		expect(parseEncryptedFile({ ...valid, key: { k: "!!!!" } })).toBeNull();
		// Pathologically long input is rejected by the char cap.
		expect(
			parseEncryptedFile({ ...valid, key: { k: "A".repeat(100000) } }),
		).toBeNull();
	});

	it("rejects an explicitly-unsupported protocol version", () => {
		expect(parseEncryptedFile({ ...valid, v: "v1" })).toBeNull();
		// Absent v is tolerated (older content) and normalizes to undefined.
		const { v: _v, ...noVersion } = valid;
		expect(parseEncryptedFile(noVersion)?.v).toBeUndefined();
	});
});

describe("encryptAttachment", () => {
	it("produces a descriptor the read path accepts and decrypts (round-trip)", async () => {
		const plaintext = new TextEncoder().encode("the quick brown fox 🦊");
		const { ciphertext, file } = await encryptAttachment(plaintext.buffer);

		// Ciphertext differs from plaintext but keeps the same byte length
		// (AES-CTR is a stream cipher).
		expect(ciphertext.byteLength).toBe(plaintext.byteLength);
		expect(new Uint8Array(ciphertext)).not.toEqual(plaintext);

		// The url-less descriptor + an uploaded url is a valid EncryptedFile that
		// the Phase 3 read path validates and decrypts back to the original.
		const full = { ...file, url: "mxc://example.com/ciphertext" };
		const parsed = parseEncryptedFile(full);
		expect(parsed).not.toBeNull();
		const decrypted = await decryptAttachment(ciphertext, parsed as never);
		expect(new Uint8Array(decrypted)).toEqual(plaintext);
	});

	it("emits a well-formed A256CTR JWK and v2 descriptor", async () => {
		const { file } = await encryptAttachment(new Uint8Array([1, 2, 3]).buffer);
		expect(file.v).toBe("v2");
		expect(file.key).toMatchObject({
			alg: "A256CTR",
			ext: true,
			kty: "oct",
			key_ops: ["encrypt", "decrypt"],
		});
		// Key 32B, IV 16B decode (base64url tolerant decode handled by read path).
		expect(file.iv.length).toBeGreaterThan(0);
		expect(file.hashes.sha256.length).toBeGreaterThan(0);
	});

	it("mints a fresh key and IV per call", async () => {
		const a = await encryptAttachment(new Uint8Array([0]).buffer);
		const b = await encryptAttachment(new Uint8Array([0]).buffer);
		expect(a.file.key.k).not.toBe(b.file.key.k);
		expect(a.file.iv).not.toBe(b.file.iv);
	});
});
