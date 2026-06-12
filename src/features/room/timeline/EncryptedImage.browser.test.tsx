/**
 * Browser-mode test for the inline encrypted-image render path: download →
 * verify → decrypt → display, with a closed failure on tamper. Uses real
 * WebCrypto and a stubbed `fetch` that serves the ciphertext.
 */

import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EncryptedFileInfo } from "../composer/media/attachmentCrypto";
import { EncryptedImage } from "./EncryptedImage";

function bytesToBase64Unpadded(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++)
		binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/=+$/, "");
}
function bytesToBase64Url(bytes: Uint8Array): string {
	return bytesToBase64Unpadded(bytes).replace(/\+/g, "-").replace(/\//g, "_");
}

async function encryptAttachment(
	plaintext: Uint8Array,
): Promise<{ file: EncryptedFileInfo; ciphertext: ArrayBuffer }> {
	const keyBytes = crypto.getRandomValues(new Uint8Array(32));
	const counter = new Uint8Array(16);
	counter.set(crypto.getRandomValues(new Uint8Array(8)), 0);
	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "AES-CTR" },
		false,
		["encrypt"],
	);
	const data = new Uint8Array(new ArrayBuffer(plaintext.byteLength));
	data.set(plaintext);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-CTR", counter, length: 64 },
		key,
		data,
	);
	const digest = await crypto.subtle.digest("SHA-256", ciphertext);
	return {
		ciphertext,
		file: {
			url: "mxc://example.com/ciphertext",
			key: { k: bytesToBase64Url(keyBytes) },
			iv: bytesToBase64Unpadded(counter),
			hashes: { sha256: bytesToBase64Unpadded(new Uint8Array(digest)) },
			v: "v2",
		},
	};
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("EncryptedImage", () => {
	it("downloads, decrypts, and renders the plaintext image as a blob URL", async () => {
		// A 1x1 PNG is overkill; any bytes prove the decrypt → blob → <img> path.
		const { file, ciphertext } = await encryptAttachment(
			new TextEncoder().encode("decrypted-pixels"),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(ciphertext, { status: 200 })),
		);

		const { findByAltText } = render(() => (
			<EncryptedImage
				httpUrl="https://hs.example/cipher"
				file={file}
				mimetype="image/png"
				alt="secret cat"
			/>
		));

		const img = (await findByAltText("secret cat")) as HTMLImageElement;
		expect(img.getAttribute("src")).toMatch(/^blob:/);
	});

	it("fails closed (no <img>) when the ciphertext fails its hash check", async () => {
		const { file, ciphertext } = await encryptAttachment(
			new Uint8Array([1, 2, 3, 4]),
		);
		// Corrupt the served bytes so the SHA-256 verify fails.
		const corrupted = ciphertext.slice(0);
		new Uint8Array(corrupted)[0] ^= 0xff;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(corrupted, { status: 200 })),
		);

		const { findByText, queryByAltText } = render(() => (
			<EncryptedImage
				httpUrl="https://hs.example/cipher"
				file={file}
				mimetype="image/png"
				alt="secret cat"
			/>
		));

		await findByText(/couldn't decrypt image/i);
		expect(queryByAltText("secret cat")).toBeNull();
	});

	it("fails closed (no spinner) when the encrypted descriptor is missing", async () => {
		// A malformed `content.file` projects to imageEncryptedFile=null while the
		// image is still flagged encrypted — must show an error, not spin forever.
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		const { findByText, queryByAltText } = render(() => (
			<EncryptedImage
				httpUrl="https://hs.example/cipher"
				file={null}
				mimetype="image/png"
				alt="secret cat"
			/>
		));

		await findByText(/couldn't decrypt image/i);
		expect(queryByAltText("secret cat")).toBeNull();
		// Without a descriptor there's nothing to download.
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
