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

/** Encrypt plaintext exactly as a Matrix client would, returning the descriptor. */
async function encryptAttachment(
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
		const { file, ciphertext } = await encryptAttachment(plaintext);

		const decrypted = await decryptAttachment(ciphertext, file);
		expect(new Uint8Array(decrypted)).toEqual(plaintext);
	});

	it("fails closed when the declared hash doesn't match the ciphertext", async () => {
		const { file, ciphertext } = await encryptAttachment(
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
		const { file, ciphertext } = await encryptAttachment(
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
	const valid = {
		url: "mxc://example.com/x",
		key: { k: "abc" },
		iv: "def",
		hashes: { sha256: "ghi" },
		v: "v2",
	};

	it("accepts a well-formed encrypted file", () => {
		expect(parseEncryptedFile(valid)).toEqual({
			url: "mxc://example.com/x",
			key: { k: "abc" },
			iv: "def",
			hashes: { sha256: "ghi" },
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
});
