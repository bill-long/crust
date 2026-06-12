/**
 * Browser-mode (real WebCrypto, Chromium) end-to-end test for the encrypted
 * send path: `uploadAndSend` into an encrypted room must upload *ciphertext*
 * and emit `content.file` / `info.thumbnail_file` (never cleartext urls), and
 * the emitted descriptor must decrypt back to the original bytes via the Phase 3
 * read path. The unencrypted path is covered in jsdom (uploadMedia.test.ts).
 */

import type { MatrixClient } from "matrix-js-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../../../../test/mockClient";
import { decryptAttachment, parseEncryptedFile } from "./attachmentCrypto";
import type { PendingAttachment } from "./types";
import { uploadAndSend } from "./uploadMedia";

// Stub the canvas-backed helper so the image path runs headlessly: a 1600×1200
// image yields an 800×600 thumbnail blob. `vi.hoisted` so the (hoisted) mock
// factory can reference these bytes.
const THUMB_BYTES = vi.hoisted(() => new Uint8Array([10, 20, 30, 40, 50]));
vi.mock("./imageProcessing", () => ({
	THUMBNAIL_MAX: { w: 800, h: 600 },
	inspectImage: vi.fn().mockResolvedValue({
		width: 1600,
		height: 1200,
		thumbnail: {
			blob: new Blob([THUMB_BYTES], { type: "image/jpeg" }),
			width: 800,
			height: 600,
			mimetype: "image/jpeg",
		},
	}),
}));

const ROOM = "!r:test";

/** Encrypted mock client that captures every uploaded blob and hands out unique mxc uris. */
function setup() {
	const room = createMockRoom(ROOM, [], []);
	room.__setEncrypted(true);
	const client = createMockClient(new Map([[ROOM, room]]));

	const uploads: { blob: Blob; opts: Record<string, unknown> }[] = [];
	let n = 0;
	client.uploadContent = vi
		.fn()
		.mockImplementation(async (blob: Blob, opts: Record<string, unknown>) => {
			uploads.push({ blob, opts });
			return { content_uri: `mxc://srv/${n++}` };
		});

	return { room, client: client as unknown as MatrixClient, uploads };
}

function attachment(file: File): PendingAttachment {
	return {
		id: "a1",
		file,
		kind: "image",
		previewUrl: null,
		caption: "",
		status: "ready",
		progress: 0,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("uploadAndSend (encrypted room)", () => {
	it("uploads ciphertext and emits content.file that decrypts to the original bytes", async () => {
		const { client, uploads } = setup();
		const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const file = new File([plaintext], "cat.png", { type: "image/png" });

		const content = (await uploadAndSend(
			client,
			ROOM,
			attachment(file),
		)) as unknown as Record<string, unknown>;

		// Encrypted: content.file, no cleartext url. info stays cleartext.
		expect(content.url).toBeUndefined();
		const encFile = content.file as Record<string, unknown>;
		expect(encFile).toBeDefined();
		expect(encFile.url).toBe("mxc://srv/0");
		expect(content.info).toMatchObject({ mimetype: "image/png", size: 8 });

		// The full file's ciphertext was uploaded as opaque octet-stream with no
		// filename — the server never sees the real type or name.
		const fullUpload = uploads[0];
		expect(fullUpload.opts.type).toBe("application/octet-stream");
		expect(fullUpload.opts.name).toBeUndefined();
		// The uploaded blob is ciphertext, not the plaintext file.
		const uploadedBytes = new Uint8Array(await fullUpload.blob.arrayBuffer());
		expect(uploadedBytes).not.toEqual(plaintext);

		// End-to-end: the emitted descriptor + uploaded ciphertext decrypt back
		// to the original plaintext via the Phase 3 read path.
		const parsed = parseEncryptedFile(encFile);
		expect(parsed).not.toBeNull();
		const decrypted = await decryptAttachment(
			await fullUpload.blob.arrayBuffer(),
			parsed as never,
		);
		expect(new Uint8Array(decrypted)).toEqual(plaintext);
	});

	it("encrypts the thumbnail too (info.thumbnail_file, no thumbnail_url)", async () => {
		const { client, uploads } = setup();
		const file = new File([new Uint8Array(50)], "big.png", {
			type: "image/png",
		});

		const content = (await uploadAndSend(
			client,
			ROOM,
			attachment(file),
		)) as unknown as Record<string, unknown>;

		const info = content.info as Record<string, unknown>;
		expect(info.thumbnail_url).toBeUndefined();
		const thumbFile = info.thumbnail_file as Record<string, unknown>;
		expect(thumbFile).toBeDefined();
		expect(thumbFile.url).toBe("mxc://srv/1");

		// The thumbnail ciphertext (second upload) decrypts back to the stub bytes,
		// and like the full file it leaks no filename to the server.
		const thumbUpload = uploads[1];
		expect(thumbUpload.opts.type).toBe("application/octet-stream");
		expect(thumbUpload.opts.name).toBeUndefined();
		const parsed = parseEncryptedFile(thumbFile);
		const decrypted = await decryptAttachment(
			await thumbUpload.blob.arrayBuffer(),
			parsed as never,
		);
		expect(new Uint8Array(decrypted)).toEqual(THUMB_BYTES);
	});
});
