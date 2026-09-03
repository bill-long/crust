import type { MatrixEvent } from "matrix-js-sdk";
import { EventStatus } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { canForward, forwardMessage } from "./forwardMessage";
import type { TimelineEvent } from "./timelineTypes";

const uploadBlobMock = vi.fn();
vi.mock("../composer/media/uploadMedia", () => ({
	uploadBlob: (...args: unknown[]) => uploadBlobMock(...args),
}));

const decryptAttachmentMock = vi.fn();
vi.mock("../composer/media/attachmentCrypto", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../composer/media/attachmentCrypto")>();
	return {
		...original,
		decryptAttachment: (...args: unknown[]) => decryptAttachmentMock(...args),
	};
});

function makeTimelineEvent(
	overrides: Partial<TimelineEvent> = {},
): TimelineEvent {
	return {
		eventId: "$ev",
		senderId: "@alice:example.com",
		senderName: "Alice",
		senderAvatarUrl: null,
		timestamp: 1000,
		type: "m.room.message",
		msgtype: "m.text",
		body: "hello",
		format: null,
		formattedBody: null,
		mediaUrl: null,
		mediaWidth: null,
		mediaHeight: null,
		mediaFullUrl: null,
		mediaPosterUrl: null,
		mediaMimetype: null,
		mediaSize: null,
		mediaFilename: null,
		mediaCaption: null,
		mediaThumbnailUrl: null,
		mediaThumbnailFile: null,
		mediaThumbnailMimetype: null,
		mediaIsEncrypted: false,
		mediaEncryptedFile: null,
		isVoice: false,
		voiceDurationMs: null,
		voiceWaveform: null,
		isEncrypted: false,
		isDecryptionFailure: false,
		isEdited: false,
		replyToId: null,
		replyToSender: null,
		replyToBody: null,
		replyToThumbUrl: null,
		replyToThumbEncryptedFile: null,
		replyToThumbMimetype: null,
		reactions: {},
		myReactions: {},
		status: null,
		stateNotice: null,
		membershipTransition: null,
		poll: null,
		thread: null,
		...overrides,
	};
}

function makeSourceEvent(content: Record<string, unknown>): MatrixEvent {
	return { getContent: () => content } as unknown as MatrixEvent;
}

/** Valid EncryptedFileInfo-shaped fixture (32B key / 16B iv / 32B hash,
    base64url-unpadded). */
const ENCRYPTED_FILE = {
	url: "mxc://example.com/ciphertext",
	v: "v2",
	key: {
		kty: "oct",
		k: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		alg: "A256CTR",
		ext: true,
		key_ops: ["encrypt", "decrypt"],
	},
	iv: "AAAAAAAAAAAAAAAAAAAAAA",
	hashes: { sha256: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
};

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

describe("canForward", () => {
	it("allows server-confirmed text and media messages", () => {
		expect(canForward(makeTimelineEvent())).toBe(true);
		expect(canForward(makeTimelineEvent({ msgtype: "m.emote" }))).toBe(true);
		expect(canForward(makeTimelineEvent({ msgtype: "m.image" }))).toBe(true);
		expect(canForward(makeTimelineEvent({ msgtype: "m.audio" }))).toBe(true);
		expect(canForward(makeTimelineEvent({ msgtype: "m.file" }))).toBe(true);
	});

	it("rejects local echoes, notices, and decryption failures", () => {
		expect(
			canForward(makeTimelineEvent({ status: EventStatus.NOT_SENT })),
		).toBe(false);
		expect(canForward(makeTimelineEvent({ status: EventStatus.SENDING }))).toBe(
			false,
		);
		expect(
			canForward(
				makeTimelineEvent({
					stateNotice: { text: "joined", icon: "info" } as never,
				}),
			),
		).toBe(false);
		expect(canForward(makeTimelineEvent({ isDecryptionFailure: true }))).toBe(
			false,
		);
	});

	it("rejects unsupported msgtypes", () => {
		expect(canForward(makeTimelineEvent({ msgtype: "m.poll.start" }))).toBe(
			false,
		);
		expect(canForward(makeTimelineEvent({ msgtype: "m.sticker" }))).toBe(false);
	});
});

describe("forwardMessage - text", () => {
	it("rebuilds text content, stripping the reply relation and fallback", async () => {
		const client = createMockClient();
		const source = makeSourceEvent({
			msgtype: "m.text",
			body: "> <@bob:example.com> quoted\n\nactual text",
			format: "org.matrix.custom.html",
			formatted_body:
				"<mx-reply><blockquote>quoted</blockquote></mx-reply><b>actual</b> text",
			"m.relates_to": {
				"m.in_reply_to": { event_id: "$parent" },
			},
		});
		await forwardMessage(client as never, source, "!target:example.com");
		expect(client.sendMessage).toHaveBeenCalledWith(
			"!target:example.com",
			null,
			{
				msgtype: "m.text",
				body: "actual text",
				format: "org.matrix.custom.html",
				formatted_body: "<b>actual</b> text",
			},
		);
	});

	it("preserves the msgtype for emotes", async () => {
		const client = createMockClient();
		const source = makeSourceEvent({ msgtype: "m.emote", body: "waves" });
		await forwardMessage(client as never, source, "!target:example.com");
		expect(client.sendMessage).toHaveBeenCalledWith(
			"!target:example.com",
			null,
			{
				msgtype: "m.emote",
				body: "waves",
			},
		);
	});

	it("rejects unsupported msgtypes without sending", async () => {
		const client = createMockClient();
		const source = makeSourceEvent({ msgtype: "m.poll.start", body: "poll" });
		await expect(
			forwardMessage(client as never, source, "!target:example.com"),
		).rejects.toThrow("can't be forwarded");
		expect(client.sendMessage).not.toHaveBeenCalled();
	});
});

describe("forwardMessage - media", () => {
	it("copies content verbatim between two unencrypted rooms", async () => {
		const targetRoom = createMockRoom("!target:example.com");
		targetRoom.hasEncryptionStateEvent = () => false;
		const rooms = new Map([["!target:example.com", targetRoom]]);
		const client = createMockClient(rooms as never);
		const info = {
			mimetype: "image/png",
			size: 1234,
			w: 100,
			h: 80,
			thumbnail_url: "mxc://example.com/thumb",
		};
		const source = makeSourceEvent({
			msgtype: "m.image",
			body: "photo.png",
			filename: "photo.png",
			url: "mxc://example.com/image",
			info,
		});
		await forwardMessage(client as never, source, "!target:example.com");
		expect(client.sendMessage).toHaveBeenCalledWith(
			"!target:example.com",
			null,
			{
				msgtype: "m.image",
				body: "photo.png",
				filename: "photo.png",
				url: "mxc://example.com/image",
				info,
			},
		);
		// Verbatim path: no download, no re-upload.
		expect(uploadBlobMock).not.toHaveBeenCalled();
	});

	it("never forwards an empty body when the source body was only bidi controls", async () => {
		const targetRoom = createMockRoom("!target:example.com");
		targetRoom.hasEncryptionStateEvent = () => false;
		const rooms = new Map([["!target:example.com", targetRoom]]);
		const client = createMockClient(rooms as never);
		const RLO = String.fromCharCode(0x202e);
		// With a filename, the body falls back to it (the pair stays equal).
		await forwardMessage(
			client as never,
			makeSourceEvent({
				msgtype: "m.file",
				body: RLO,
				filename: "report.pdf",
				url: "mxc://example.com/file",
			}),
			"!target:example.com",
		);
		expect(client.sendMessage).toHaveBeenLastCalledWith(
			"!target:example.com",
			null,
			{
				msgtype: "m.file",
				body: "report.pdf",
				filename: "report.pdf",
				url: "mxc://example.com/file",
			},
		);
		// Without one, the generic label - never an empty string.
		await forwardMessage(
			client as never,
			makeSourceEvent({
				msgtype: "m.file",
				body: RLO,
				url: "mxc://example.com/file",
			}),
			"!target:example.com",
		);
		expect(client.sendMessage).toHaveBeenLastCalledWith(
			"!target:example.com",
			null,
			{ msgtype: "m.file", body: "file", url: "mxc://example.com/file" },
		);
		// A body of nothing but control characters is as empty as one of
		// nothing but bidi controls.
		await forwardMessage(
			client as never,
			makeSourceEvent({
				msgtype: "m.file",
				body: String.fromCharCode(0x00),
				url: "mxc://example.com/file",
			}),
			"!target:example.com",
		);
		expect(client.sendMessage).toHaveBeenLastCalledWith(
			"!target:example.com",
			null,
			{ msgtype: "m.file", body: "file", url: "mxc://example.com/file" },
		);
		// Control characters inside a caption are dropped, newlines kept: the
		// event goes out under the forwarder's name, so it gets the caption
		// rule a fresh send gets.
		await forwardMessage(
			client as never,
			makeSourceEvent({
				msgtype: "m.image",
				body:
					"cap" +
					String.fromCharCode(0x00) +
					"tion" +
					String.fromCharCode(10) +
					"line two",
				filename: "photo.png",
				url: "mxc://example.com/image",
			}),
			"!target:example.com",
		);
		expect(client.sendMessage).toHaveBeenLastCalledWith(
			"!target:example.com",
			null,
			{
				msgtype: "m.image",
				body: `caption${String.fromCharCode(10)}line two`,
				filename: "photo.png",
				url: "mxc://example.com/image",
			},
		);
		// A body that was the filename verbatim stays equal to the filename
		// even when the filename rule drops a separator from it.
		await forwardMessage(
			client as never,
			makeSourceEvent({
				msgtype: "m.image",
				body: "2024/report.png",
				filename: "2024/report.png",
				url: "mxc://example.com/image",
			}),
			"!target:example.com",
		);
		expect(client.sendMessage).toHaveBeenLastCalledWith(
			"!target:example.com",
			null,
			{
				msgtype: "m.image",
				body: "2024report.png",
				filename: "2024report.png",
				url: "mxc://example.com/image",
			},
		);
		// A reply quote followed by only a control must not come back as
		// the forwarder's own words.
		await forwardMessage(
			client as never,
			makeSourceEvent({
				msgtype: "m.file",
				body:
					"> <@alice:example.com> secret plan" +
					String.fromCharCode(10, 10) +
					RLO,
				url: "mxc://example.com/file",
			}),
			"!target:example.com",
		);
		expect(client.sendMessage).toHaveBeenLastCalledWith(
			"!target:example.com",
			null,
			{ msgtype: "m.file", body: "file", url: "mxc://example.com/file" },
		);
	});

	it("strips bidi scope controls from the forwarded filename and body", async () => {
		const targetRoom = createMockRoom("!target:example.com");
		targetRoom.hasEncryptionStateEvent = () => false;
		const rooms = new Map([["!target:example.com", targetRoom]]);
		const client = createMockClient(rooms as never);
		// The forward goes out under the forwarder's name, so it must not
		// republish an extension spoof the forwarder never typed - the same
		// strips a fresh upload gets, with the filename/body pair kept equal.
		const RLO = String.fromCharCode(0x202e);
		const source = makeSourceEvent({
			msgtype: "m.file",
			body: `invoice${RLO}gnp.exe`,
			filename: `invoice${RLO}gnp.exe`,
			url: "mxc://example.com/file",
		});
		await forwardMessage(client as never, source, "!target:example.com");
		expect(client.sendMessage).toHaveBeenCalledWith(
			"!target:example.com",
			null,
			{
				msgtype: "m.file",
				body: "invoicegnp.exe",
				filename: "invoicegnp.exe",
				url: "mxc://example.com/file",
			},
		);
	});

	it("strips the reply fallback from a media body", async () => {
		const targetRoom = createMockRoom("!target:example.com");
		targetRoom.hasEncryptionStateEvent = () => false;
		const rooms = new Map([["!target:example.com", targetRoom]]);
		const client = createMockClient(rooms as never);
		// Reply fallbacks live in `body` for media events too: the quoted
		// preamble must not ride the forward into the target room.
		const source = makeSourceEvent({
			msgtype: "m.image",
			body: "> <@bob:example.com> quoted\n\nphoto.png",
			filename: "photo.png",
			url: "mxc://example.com/image",
		});
		await forwardMessage(client as never, source, "!target:example.com");
		expect(client.sendMessage).toHaveBeenCalledWith(
			"!target:example.com",
			null,
			{
				msgtype: "m.image",
				body: "photo.png",
				filename: "photo.png",
				url: "mxc://example.com/image",
			},
		);
	});

	it("keeps the raw media body when stripping the fallback empties it", async () => {
		const targetRoom = createMockRoom("!target:example.com");
		targetRoom.hasEncryptionStateEvent = () => false;
		const rooms = new Map([["!target:example.com", targetRoom]]);
		const client = createMockClient(rooms as never);
		// Malformed source: fallback + blank line and nothing after, so the
		// spec-shaped strip empties the body. A media body doubles as the
		// caption, so an empty result falls back to the raw (trimmed) body.
		const source = makeSourceEvent({
			msgtype: "m.file",
			body: "> <@bob:example.com> only the quote\n\n",
			url: "mxc://example.com/file",
		});
		await forwardMessage(client as never, source, "!target:example.com");
		expect(client.sendMessage).toHaveBeenCalledWith(
			"!target:example.com",
			null,
			expect.objectContaining({
				body: "> <@bob:example.com> only the quote",
			}),
		);
	});

	it("re-uploads when the target room is encrypted", async () => {
		const targetRoom = createMockRoom("!target:example.com");
		targetRoom.hasEncryptionStateEvent = () => true;
		const rooms = new Map([["!target:example.com", targetRoom]]);
		const client = createMockClient(rooms as never);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				arrayBuffer: async () => new ArrayBuffer(8),
			}),
		);
		uploadBlobMock.mockResolvedValue({
			file: { ...ENCRYPTED_FILE, url: "mxc://example.com/newcipher" },
		});
		const source = makeSourceEvent({
			msgtype: "m.image",
			body: "photo.png",
			filename: "photo.png",
			url: "mxc://example.com/image",
			info: {
				mimetype: "image/png",
				size: 8,
				w: 100,
				h: 80,
				thumbnail_url: "mxc://example.com/thumb",
			},
		});
		await forwardMessage(client as never, source, "!target:example.com");
		expect(uploadBlobMock).toHaveBeenCalledOnce();
		expect(uploadBlobMock.mock.calls[0][2]).toMatchObject({
			encrypted: true,
			type: "image/png",
		});
		const sent = client.sendMessage.mock.calls[0][2] as Record<string, unknown>;
		expect(sent.msgtype).toBe("m.image");
		expect(sent.file).toMatchObject({ url: "mxc://example.com/newcipher" });
		expect(sent.url).toBeUndefined();
		// Thumbnail keys from the source upload never survive a re-upload.
		const sentInfo = sent.info as Record<string, unknown>;
		expect(sentInfo.thumbnail_url).toBeUndefined();
		expect(sentInfo.w).toBe(100);
		expect(sentInfo.mimetype).toBe("image/png");
	});

	it("downloads, decrypts, and re-uploads an encrypted source", async () => {
		const targetRoom = createMockRoom("!target:example.com");
		targetRoom.hasEncryptionStateEvent = () => false;
		const rooms = new Map([["!target:example.com", targetRoom]]);
		const client = createMockClient(rooms as never);
		const plaintext = new ArrayBuffer(8);
		decryptAttachmentMock.mockResolvedValue(plaintext);
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			arrayBuffer: async () => new ArrayBuffer(16),
		});
		vi.stubGlobal("fetch", fetchMock);
		uploadBlobMock.mockResolvedValue({
			contentUri: "mxc://example.com/reuploaded",
		});
		const source = makeSourceEvent({
			msgtype: "m.file",
			body: "report.pdf",
			filename: "report.pdf",
			file: ENCRYPTED_FILE,
			info: {
				mimetype: "application/pdf",
				size: 16,
				thumbnail_file: { url: "mxc://example.com/thumbcipher" },
				thumbnail_info: { mimetype: "image/png" },
			},
		});
		await forwardMessage(client as never, source, "!target:example.com");
		expect(decryptAttachmentMock).toHaveBeenCalledOnce();
		expect(uploadBlobMock).toHaveBeenCalledOnce();
		expect(uploadBlobMock.mock.calls[0][2]).toMatchObject({
			encrypted: false,
			type: "application/pdf",
		});
		const sent = client.sendMessage.mock.calls[0][2] as Record<string, unknown>;
		expect(sent.url).toBe("mxc://example.com/reuploaded");
		expect(sent.file).toBeUndefined();
		const sentInfo = sent.info as Record<string, unknown>;
		expect(sentInfo.thumbnail_file).toBeUndefined();
		expect(sentInfo.thumbnail_info).toBeUndefined();
	});

	it("preserves voice-message rendering hints across a re-upload", async () => {
		const targetRoom = createMockRoom("!target:example.com");
		targetRoom.hasEncryptionStateEvent = () => true;
		const rooms = new Map([["!target:example.com", targetRoom]]);
		const client = createMockClient(rooms as never);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				arrayBuffer: async () => new ArrayBuffer(8),
			}),
		);
		uploadBlobMock.mockResolvedValue({
			file: { ...ENCRYPTED_FILE, url: "mxc://example.com/newcipher" },
		});
		const source = makeSourceEvent({
			msgtype: "m.audio",
			body: "Voice message",
			url: "mxc://example.com/voice",
			"org.matrix.msc3245.voice": {},
			info: {
				mimetype: "audio/ogg",
				duration: 1200,
				"org.matrix.msc1767.audio": {
					duration: 1200,
					waveform: [0, 512, 1024],
				},
			},
		});
		await forwardMessage(client as never, source, "!target:example.com");
		const sent = client.sendMessage.mock.calls[0][2] as Record<string, unknown>;
		expect(sent["org.matrix.msc3245.voice"]).toEqual({});
		const sentInfo = sent.info as Record<string, unknown>;
		expect(sentInfo["org.matrix.msc1767.audio"]).toEqual({
			duration: 1200,
			waveform: [0, 512, 1024],
		});
	});

	it("propagates a download failure without sending", async () => {
		const targetRoom = createMockRoom("!target:example.com");
		targetRoom.hasEncryptionStateEvent = () => true;
		const rooms = new Map([["!target:example.com", targetRoom]]);
		const client = createMockClient(rooms as never);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 404 }),
		);
		const source = makeSourceEvent({
			msgtype: "m.image",
			body: "gone.png",
			url: "mxc://example.com/gone",
			info: { mimetype: "image/png" },
		});
		await expect(
			forwardMessage(client as never, source, "!target:example.com"),
		).rejects.toThrow("HTTP 404");
		expect(client.sendMessage).not.toHaveBeenCalled();
	});
});
