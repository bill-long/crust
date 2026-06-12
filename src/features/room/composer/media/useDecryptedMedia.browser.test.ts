/**
 * Browser-mode test for createDecryptedObjectUrl's loading-gating: while a
 * decrypt is in flight (or there's no source), the hook must not expose the
 * resource's *retained previous* value, so switching between encrypted images
 * never briefly leaks the prior image's blob.
 */

import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EncryptedFileInfo } from "./attachmentCrypto";
import { createDecryptedObjectUrl } from "./useDecryptedMedia";

const SAMPLE_FILE: EncryptedFileInfo = {
	url: "mxc://example.com/ciphertext",
	key: { k: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
	iv: "AAAAAAAAAAAAAAAAAAAAAA==",
	hashes: { sha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
	v: "v2",
};

afterEach(() => vi.unstubAllGlobals());

describe("createDecryptedObjectUrl loading gate", () => {
	it("exposes no url/blob/failed while a decrypt is in flight", async () => {
		// Hold the ciphertext fetch open so the resource stays loading.
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise(() => {})),
		);

		await createRoot(async (dispose) => {
			const media = createDecryptedObjectUrl(
				() => "https://hs.example/cipher",
				() => SAMPLE_FILE,
				() => "image/png",
			);
			// Let the resource kick off its fetch.
			await Promise.resolve();

			expect(media.loading()).toBe(true);
			expect(media.url()).toBeNull();
			expect(media.blob()).toBeNull();
			expect(media.failed()).toBe(false);
			dispose();
		});
	});

	it("exposes nothing when there is no source", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise(() => {})),
		);
		await createRoot(async (dispose) => {
			const media = createDecryptedObjectUrl(
				() => null,
				() => null,
				() => null,
			);
			await Promise.resolve();
			expect(media.url()).toBeNull();
			expect(media.blob()).toBeNull();
			expect(media.failed()).toBe(false);
			dispose();
		});
	});
});
