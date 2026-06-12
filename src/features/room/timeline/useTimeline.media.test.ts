import type { MatrixClient } from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { useTimeline } from "./useTimeline";

/**
 * Projection coverage for non-image attachments (`m.file` / `m.video` /
 * `m.audio`) added in Media Phase 5 (#279). The image cases live in
 * `useTimeline.test.ts`; these exercise the generalized `media*` fields the
 * file/video/audio renderers read.
 */

/** Run a test inside createRoot, disposing afterward. */
function withRoot(fn: () => Promise<void>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		createRoot(async (dispose) => {
			try {
				await fn();
				dispose();
				resolve();
			} catch (e) {
				dispose();
				reject(e);
			}
		});
	});
}

/** Wait for TimelineWindow.load()'s microtask chain to settle. */
function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

const HTTP = "https://example.com/_matrix/media/v3/download";

describe("useTimeline media projection", () => {
	it("projects url / mimetype / size / filename for plain m.file, m.video, m.audio", async () => {
		const roomA = createMockRoom("!roomA:test", [
			{
				eventId: "$file",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.file",
					body: "report.pdf",
					filename: "report.pdf",
					url: "mxc://test/doc",
					info: { mimetype: "application/pdf", size: 2048 },
				},
				ts: 1000,
			},
			{
				eventId: "$video",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.video",
					body: "clip.mp4",
					filename: "clip.mp4",
					url: "mxc://test/vid",
					info: {
						mimetype: "video/mp4",
						size: 4096,
						w: 640,
						h: 480,
						thumbnail_url: "mxc://test/poster",
					},
				},
				ts: 2000,
			},
			{
				eventId: "$audio",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.audio",
					body: "song.mp3",
					filename: "song.mp3",
					url: "mxc://test/song",
					info: { mimetype: "audio/mpeg", size: 1024 },
				},
				ts: 3000,
			},
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			const [file, video, audio] = events;

			expect(file.mediaFullUrl).toBe(`${HTTP}/test/doc`);
			expect(file.mediaMimetype).toBe("application/pdf");
			expect(file.mediaSize).toBe(2048);
			expect(file.mediaFilename).toBe("report.pdf");
			expect(file.mediaIsEncrypted).toBe(false);
			expect(file.mediaEncryptedFile).toBeNull();
			// Files have no visual box, so intrinsic dims stay null.
			expect(file.mediaWidth).toBeNull();
			expect(file.mediaHeight).toBeNull();

			expect(video.mediaFullUrl).toBe(`${HTTP}/test/vid`);
			expect(video.mediaMimetype).toBe("video/mp4");
			expect(video.mediaSize).toBe(4096);
			expect(video.mediaWidth).toBe(640);
			expect(video.mediaHeight).toBe(480);
			// Plain video poster comes from the cleartext thumbnail_url.
			expect(video.mediaPosterUrl).toBe(`${HTTP}/test/poster`);
			expect(video.mediaIsEncrypted).toBe(false);

			expect(audio.mediaFullUrl).toBe(`${HTTP}/test/song`);
			expect(audio.mediaMimetype).toBe("audio/mpeg");
			expect(audio.mediaSize).toBe(1024);
			expect(audio.mediaFilename).toBe("song.mp3");
			// Audio has no poster and no intrinsic box.
			expect(audio.mediaPosterUrl).toBeNull();
			expect(audio.mediaWidth).toBeNull();
		});
	});

	it("parses the EncryptedFile descriptor for encrypted m.video / m.audio / m.file and fails closed on a malformed one", async () => {
		const validFile = (url: string) => ({
			url,
			key: { k: "A".repeat(43) },
			iv: "AAAAAAAAAAAAAAAAAAAAAA==",
			hashes: { sha256: "A".repeat(43) },
			v: "v2",
		});

		const roomA = createMockRoom("!roomA:test", [
			{
				eventId: "$encVideo",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.video",
					body: "secret.mp4",
					file: validFile("mxc://test/encvid"),
					info: { mimetype: "video/mp4", size: 10, w: 320, h: 240 },
				},
				ts: 1000,
			},
			{
				eventId: "$encAudio",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.audio",
					body: "secret.mp3",
					file: validFile("mxc://test/encaud"),
					info: { mimetype: "audio/mpeg", size: 20 },
				},
				ts: 2000,
			},
			{
				eventId: "$badFile",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.file",
					body: "secret.bin",
					// Malformed: key is too short to be a 32-byte AES key.
					file: { url: "mxc://test/bad", key: { k: "x" } },
					info: { mimetype: "application/octet-stream", size: 30 },
				},
				ts: 3000,
			},
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			const [video, audio, badFile] = events;

			expect(video.mediaIsEncrypted).toBe(true);
			expect(video.mediaFullUrl).toBe(`${HTTP}/test/encvid`);
			expect(video.mediaEncryptedFile).toEqual({
				url: "mxc://test/encvid",
				key: { k: "A".repeat(43) },
				iv: "AAAAAAAAAAAAAAAAAAAAAA==",
				hashes: { sha256: "A".repeat(43) },
				v: "v2",
			});
			expect(video.mediaWidth).toBe(320);

			expect(audio.mediaIsEncrypted).toBe(true);
			expect(audio.mediaEncryptedFile).not.toBeNull();

			// Fail closed: flagged encrypted, but no usable descriptor — the
			// renderer must show an error, never the ciphertext.
			expect(badFile.mediaIsEncrypted).toBe(true);
			expect(badFile.mediaEncryptedFile).toBeNull();
		});
	});

	it("never derives a poster from an encrypted video's thumbnail", async () => {
		const roomA = createMockRoom("!roomA:test", [
			{
				eventId: "$encVideo",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.room.message",
				content: {
					msgtype: "m.video",
					body: "secret.mp4",
					file: {
						url: "mxc://test/encvid",
						key: { k: "A".repeat(43) },
						iv: "AAAAAAAAAAAAAAAAAAAAAA==",
						hashes: { sha256: "A".repeat(43) },
						v: "v2",
					},
					info: {
						mimetype: "video/mp4",
						size: 10,
						// A cleartext thumbnail_url shouldn't be trusted as a poster on an
						// encrypted event; encrypted thumbnails (thumbnail_file) are deferred.
						thumbnail_url: "mxc://test/leak",
					},
				},
				ts: 1000,
			},
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			expect(events[0].mediaIsEncrypted).toBe(true);
			expect(events[0].mediaPosterUrl).toBeNull();
		});
	});

	it("flags an encrypted m.sticker so it decrypts instead of rendering ciphertext", async () => {
		const roomA = createMockRoom("!roomA:test", [
			// Plain sticker (uses the m.sticker type, not a msgtype).
			{
				eventId: "$plainSticker",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.sticker",
				content: {
					body: "wave",
					url: "mxc://test/plainsticker",
					info: { w: 128, h: 128, mimetype: "image/png" },
				},
				ts: 1000,
			},
			// Encrypted sticker: carries content.file (ciphertext), no content.url.
			{
				eventId: "$encSticker",
				roomId: "!roomA:test",
				sender: "@alice:test",
				type: "m.sticker",
				content: {
					body: "secret",
					file: {
						url: "mxc://test/encsticker",
						key: { k: "A".repeat(43) },
						iv: "AAAAAAAAAAAAAAAAAAAAAA==",
						hashes: { sha256: "A".repeat(43) },
						v: "v2",
					},
					info: { w: 128, h: 128, mimetype: "image/png" },
				},
				ts: 2000,
			},
		]);

		const client = createMockClient(new Map([["!roomA:test", roomA]]));

		await withRoot(async () => {
			const { events } = useTimeline(
				client as unknown as MatrixClient,
				() => "!roomA:test",
			);
			await flushPromises();

			const [plain, enc] = events;

			expect(plain.mediaIsEncrypted).toBe(false);
			expect(plain.mediaEncryptedFile).toBeNull();

			// The authoritative flag is set and the descriptor parses, so the
			// renderer decrypts rather than pointing an <img> at the ciphertext.
			expect(enc.mediaIsEncrypted).toBe(true);
			expect(enc.mediaEncryptedFile).not.toBeNull();
			expect(enc.mediaFullUrl).toBe(`${HTTP}/test/encsticker`);
		});
	});
});
