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

	it("never derives the cleartext poster URL for an encrypted video", async () => {
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
						// encrypted event. The encrypted poster path uses thumbnail_file
						// (the mediaThumbnail* fields), never this cleartext URL.
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

	describe("image captions (#286)", () => {
		it("surfaces content.body as a caption only when filename is present and differs", async () => {
			const roomA = createMockRoom("!roomA:test", [
				// Caption present: filename + a differing body.
				{
					eventId: "$captioned",
					roomId: "!roomA:test",
					sender: "@alice:test",
					type: "m.room.message",
					content: {
						msgtype: "m.image",
						body: "Look at this sunset 🌅",
						filename: "sunset.png",
						url: "mxc://test/sunset",
						info: { mimetype: "image/png", w: 100, h: 100 },
					},
					ts: 1000,
				},
				// No caption: body equals the filename.
				{
					eventId: "$noCaption",
					roomId: "!roomA:test",
					sender: "@alice:test",
					type: "m.room.message",
					content: {
						msgtype: "m.image",
						body: "photo.png",
						filename: "photo.png",
						url: "mxc://test/photo",
						info: { mimetype: "image/png", w: 100, h: 100 },
					},
					ts: 2000,
				},
				// No explicit filename: body IS the filename, so it's not a caption.
				{
					eventId: "$legacy",
					roomId: "!roomA:test",
					sender: "@alice:test",
					type: "m.room.message",
					content: {
						msgtype: "m.image",
						body: "old-client.png",
						url: "mxc://test/legacy",
						info: { mimetype: "image/png", w: 100, h: 100 },
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

				const [captioned, noCaption, legacy] = events;
				expect(captioned.mediaCaption).toBe("Look at this sunset 🌅");
				expect(noCaption.mediaCaption).toBeNull();
				expect(legacy.mediaCaption).toBeNull();
			});
		});

		it("strips control chars from a caption and never sets one for non-image attachments", async () => {
			const roomA = createMockRoom("!roomA:test", [
				{
					eventId: "$ctrl",
					roomId: "!roomA:test",
					sender: "@alice:test",
					type: "m.room.message",
					content: {
						msgtype: "m.image",
						// A non-newline control char (BEL) in the caption is stripped.
						body: "line\u0007one",
						filename: "img.png",
						url: "mxc://test/ctrl",
						info: { mimetype: "image/png", w: 10, h: 10 },
					},
					ts: 1000,
				},
				// Multi-line captions keep their newlines (CRLF normalized to LF)
				// since the caption renders with whitespace-pre-wrap.
				{
					eventId: "$multiline",
					roomId: "!roomA:test",
					sender: "@alice:test",
					type: "m.room.message",
					content: {
						msgtype: "m.image",
						body: "first line\r\nsecond line",
						filename: "img2.png",
						url: "mxc://test/multiline",
						info: { mimetype: "image/png", w: 10, h: 10 },
					},
					ts: 1500,
				},
				// A control char in the FILENAME must be normalized the same way as the
				// body before the diff gate, or a caption identical to the filename leaks.
				{
					eventId: "$ctrlFilename",
					roomId: "!roomA:test",
					sender: "@alice:test",
					type: "m.room.message",
					content: {
						msgtype: "m.image",
						body: "photo.png",
						filename: "photo\u0007.png",
						url: "mxc://test/ctrlfn",
						info: { mimetype: "image/png", w: 10, h: 10 },
					},
					ts: 1800,
				},
				// A file with a differing body is a caption per spec, but captions are
				// scoped to m.image in the renderer, so the projection leaves it null.
				{
					eventId: "$fileCaption",
					roomId: "!roomA:test",
					sender: "@alice:test",
					type: "m.room.message",
					content: {
						msgtype: "m.file",
						body: "see attached",
						filename: "report.pdf",
						url: "mxc://test/doc",
						info: { mimetype: "application/pdf", size: 1 },
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

				const ctrl = events.find((e) => e.eventId === "$ctrl");
				const multiline = events.find((e) => e.eventId === "$multiline");
				const fileCaption = events.find((e) => e.eventId === "$fileCaption");
				const ctrlFilename = events.find((e) => e.eventId === "$ctrlFilename");
				expect(ctrl?.mediaCaption).toBe("lineone");
				expect(multiline?.mediaCaption).toBe("first line\nsecond line");
				expect(fileCaption?.mediaCaption).toBeNull();
				expect(ctrlFilename?.mediaCaption).toBeNull();
			});
		});
	});

	describe("reply context (#286)", () => {
		it("resolves sender + snippet from the m.in_reply_to relation, including media replies", async () => {
			const roomA = createMockRoom(
				"!roomA:test",
				[
					{
						eventId: "$parentText",
						roomId: "!roomA:test",
						sender: "@bob:test",
						type: "m.room.message",
						content: { msgtype: "m.text", body: "the original question" },
						ts: 1000,
					},
					// A media (image) event sent as a reply — carries only the relation,
					// no `> ` body prefix.
					{
						eventId: "$mediaReply",
						roomId: "!roomA:test",
						sender: "@alice:test",
						type: "m.room.message",
						content: {
							msgtype: "m.image",
							body: "answer.png",
							filename: "answer.png",
							url: "mxc://test/answer",
							info: { mimetype: "image/png", w: 10, h: 10 },
							"m.relates_to": { "m.in_reply_to": { event_id: "$parentText" } },
						},
						ts: 2000,
					},
				],
				[{ userId: "@bob:test", name: "Bob" }],
			);

			const client = createMockClient(new Map([["!roomA:test", roomA]]));

			await withRoot(async () => {
				const { events } = useTimeline(
					client as unknown as MatrixClient,
					() => "!roomA:test",
				);
				await flushPromises();

				const reply = events.find((e) => e.eventId === "$mediaReply");
				expect(reply?.replyToId).toBe("$parentText");
				expect(reply?.replyToSender).toBe("Bob");
				expect(reply?.replyToBody).toBe("the original question");
			});
		});

		it("labels a media parent and strips the parent's own reply fallback", async () => {
			const roomA = createMockRoom("!roomA:test", [
				{
					eventId: "$parentVideo",
					roomId: "!roomA:test",
					sender: "@alice:test",
					type: "m.room.message",
					content: {
						msgtype: "m.video",
						body: "clip.mp4",
						filename: "clip.mp4",
						url: "mxc://test/clip",
						info: { mimetype: "video/mp4", size: 1 },
					},
					ts: 1000,
				},
				{
					eventId: "$replyToVideo",
					roomId: "!roomA:test",
					sender: "@alice:test",
					type: "m.room.message",
					content: {
						msgtype: "m.text",
						body: "nice clip",
						"m.relates_to": { "m.in_reply_to": { event_id: "$parentVideo" } },
					},
					ts: 2000,
				},
				// Parent is itself a reply: its body carries a fallback that must be
				// stripped so the snippet shows the real text, not the quote preamble.
				{
					eventId: "$parentReply",
					roomId: "!roomA:test",
					sender: "@alice:test",
					type: "m.room.message",
					content: {
						msgtype: "m.text",
						body: "> <@bob:test> earlier\n\nactual content",
					},
					ts: 3000,
				},
				{
					eventId: "$replyToReply",
					roomId: "!roomA:test",
					sender: "@alice:test",
					type: "m.room.message",
					content: {
						msgtype: "m.text",
						body: "agreed",
						"m.relates_to": { "m.in_reply_to": { event_id: "$parentReply" } },
					},
					ts: 4000,
				},
			]);

			const client = createMockClient(new Map([["!roomA:test", roomA]]));

			await withRoot(async () => {
				const { events } = useTimeline(
					client as unknown as MatrixClient,
					() => "!roomA:test",
				);
				await flushPromises();

				const toVideo = events.find((e) => e.eventId === "$replyToVideo");
				expect(toVideo?.replyToBody).toBe("🎬 Video");

				const toReply = events.find((e) => e.eventId === "$replyToReply");
				expect(toReply?.replyToBody).toBe("actual content");
			});
		});

		it("keeps replyToId but leaves sender/body null when the parent isn't loaded", async () => {
			const roomA = createMockRoom("!roomA:test", [
				{
					eventId: "$orphanReply",
					roomId: "!roomA:test",
					sender: "@alice:test",
					type: "m.room.message",
					content: {
						msgtype: "m.text",
						body: "replying to something off-screen",
						"m.relates_to": {
							"m.in_reply_to": { event_id: "$notInWindow" },
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

				expect(events[0].replyToId).toBe("$notInWindow");
				expect(events[0].replyToSender).toBeNull();
				expect(events[0].replyToBody).toBeNull();
			});
		});
	});

	describe("encrypted video poster (#286)", () => {
		const validFile = (url: string) => ({
			url,
			key: { k: "A".repeat(43) },
			iv: "AAAAAAAAAAAAAAAAAAAAAA==",
			hashes: { sha256: "A".repeat(43) },
			v: "v2",
		});

		it("parses info.thumbnail_file into the mediaThumbnail* fields", async () => {
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
						info: {
							mimetype: "video/mp4",
							size: 10,
							thumbnail_file: validFile("mxc://test/encthumb"),
							thumbnail_info: { mimetype: "image/jpeg", w: 320, h: 240 },
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

				const [video] = events;
				expect(video.mediaIsEncrypted).toBe(true);
				expect(video.mediaThumbnailUrl).toBe(`${HTTP}/test/encthumb`);
				expect(video.mediaThumbnailFile).toEqual(
					validFile("mxc://test/encthumb"),
				);
				expect(video.mediaThumbnailMimetype).toBe("image/jpeg");
				// The cleartext poster URL stays null on an encrypted event.
				expect(video.mediaPosterUrl).toBeNull();
			});
		});

		it("fails closed to null thumbnail fields on a malformed thumbnail_file", async () => {
			const roomA = createMockRoom("!roomA:test", [
				{
					eventId: "$badThumb",
					roomId: "!roomA:test",
					sender: "@alice:test",
					type: "m.room.message",
					content: {
						msgtype: "m.video",
						body: "secret.mp4",
						file: validFile("mxc://test/encvid"),
						info: {
							mimetype: "video/mp4",
							size: 10,
							// Malformed: key too short to be a 32-byte AES key.
							thumbnail_file: { url: "mxc://test/badthumb", key: { k: "x" } },
							thumbnail_info: { mimetype: "image/jpeg" },
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

				const [video] = events;
				expect(video.mediaThumbnailFile).toBeNull();
				expect(video.mediaThumbnailUrl).toBeNull();
				expect(video.mediaThumbnailMimetype).toBeNull();
			});
		});

		it("never sets thumbnail fields for a plain video", async () => {
			const roomA = createMockRoom("!roomA:test", [
				{
					eventId: "$plainVideo",
					roomId: "!roomA:test",
					sender: "@alice:test",
					type: "m.room.message",
					content: {
						msgtype: "m.video",
						body: "clip.mp4",
						url: "mxc://test/vid",
						info: {
							mimetype: "video/mp4",
							size: 10,
							thumbnail_url: "mxc://test/poster",
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

				const [video] = events;
				expect(video.mediaThumbnailFile).toBeNull();
				expect(video.mediaThumbnailUrl).toBeNull();
				expect(video.mediaPosterUrl).toBe(`${HTTP}/test/poster`);
			});
		});
	});
});
