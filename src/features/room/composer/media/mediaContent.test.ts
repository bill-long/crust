import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../timeline/useTimeline";
import type { EncryptedFile } from "./attachmentCrypto";
import {
	buildMediaContent,
	classifyFile,
	msgtypeForKind,
} from "./mediaContent";

const file = (name: string, type: string): File =>
	new File(["x"], name, { type });

describe("classifyFile", () => {
	it("classifies by MIME prefix", () => {
		expect(classifyFile(file("a.png", "image/png"))).toBe("image");
		expect(classifyFile(file("a.mp4", "video/mp4"))).toBe("video");
		expect(classifyFile(file("a.mp3", "audio/mpeg"))).toBe("audio");
		expect(classifyFile(file("a.pdf", "application/pdf"))).toBe("file");
	});

	it("falls back to file for empty/unknown types", () => {
		expect(classifyFile(file("a", ""))).toBe("file");
	});
});

describe("msgtypeForKind", () => {
	it("maps each kind", () => {
		expect(msgtypeForKind("image")).toBe("m.image");
		expect(msgtypeForKind("video")).toBe("m.video");
		expect(msgtypeForKind("audio")).toBe("m.audio");
		expect(msgtypeForKind("file")).toBe("m.file");
	});
});

describe("buildMediaContent", () => {
	it("builds an m.image with info and filename body", () => {
		const c = buildMediaContent({
			kind: "image",
			contentUri: "mxc://srv/abc",
			filename: "cat.png",
			mimetype: "image/png",
			size: 1234,
			width: 800,
			height: 600,
		}) as unknown as Record<string, unknown>;

		expect(c.msgtype).toBe("m.image");
		expect(c.url).toBe("mxc://srv/abc");
		expect(c.filename).toBe("cat.png");
		// No caption → body is the filename.
		expect(c.body).toBe("cat.png");
		expect(c.info).toMatchObject({
			w: 800,
			h: 600,
			mimetype: "image/png",
			size: 1234,
		});
	});

	it("uses the caption for body but keeps the real filename", () => {
		const c = buildMediaContent({
			kind: "image",
			contentUri: "mxc://srv/abc",
			filename: "cat.png",
			mimetype: "image/png",
			size: 1,
			caption: "  my cat  ",
		}) as unknown as Record<string, unknown>;
		expect(c.body).toBe("my cat");
		expect(c.filename).toBe("cat.png");
	});

	it("embeds a thumbnail block when provided", () => {
		const c = buildMediaContent({
			kind: "image",
			contentUri: "mxc://srv/full",
			filename: "big.jpg",
			mimetype: "image/jpeg",
			size: 9000,
			width: 4000,
			height: 3000,
			thumbnail: {
				contentUri: "mxc://srv/thumb",
				mimetype: "image/jpeg",
				size: 500,
				w: 800,
				h: 600,
			},
		}) as unknown as Record<string, unknown>;
		const info = c.info as Record<string, unknown>;
		expect(info.thumbnail_url).toBe("mxc://srv/thumb");
		expect(info.thumbnail_info).toMatchObject({ w: 800, h: 600, size: 500 });
	});

	it("omits zero/invalid dimensions", () => {
		const c = buildMediaContent({
			kind: "file",
			contentUri: "mxc://srv/x",
			filename: "doc.pdf",
			mimetype: "application/pdf",
			size: 10,
		}) as unknown as Record<string, unknown>;
		const info = c.info as Record<string, unknown>;
		expect(info.w).toBeUndefined();
		expect(info.h).toBeUndefined();
		expect(c.msgtype).toBe("m.file");
	});

	const encFile = (k: string): EncryptedFile => ({
		url: `mxc://srv/${k}`,
		key: {
			alg: "A256CTR",
			ext: true,
			k: "A".repeat(43),
			key_ops: ["encrypt", "decrypt"],
			kty: "oct",
		},
		iv: "AAAAAAAAAAAAAAAAAAAAAA==",
		hashes: { sha256: "A".repeat(43) },
		v: "v2",
	});

	it("emits content.file (not url) for an encrypted attachment", () => {
		const file = encFile("full");
		const c = buildMediaContent({
			kind: "image",
			file,
			filename: "cat.png",
			mimetype: "image/png",
			size: 1234,
			width: 800,
			height: 600,
		}) as unknown as Record<string, unknown>;
		expect(c.file).toEqual(file);
		expect(c.url).toBeUndefined();
		// `info` stays cleartext so receivers can read mimetype/size/dimensions.
		expect(c.info).toMatchObject({ w: 800, h: 600, mimetype: "image/png" });
	});

	it("emits info.thumbnail_file (not thumbnail_url) for an encrypted thumbnail", () => {
		const file = encFile("full");
		const thumbFile = encFile("thumb");
		const c = buildMediaContent({
			kind: "image",
			file,
			filename: "big.jpg",
			mimetype: "image/jpeg",
			size: 9000,
			thumbnail: {
				file: thumbFile,
				mimetype: "image/jpeg",
				size: 500,
				w: 800,
				h: 600,
			},
		}) as unknown as Record<string, unknown>;
		const info = c.info as Record<string, unknown>;
		expect(info.thumbnail_file).toEqual(thumbFile);
		expect(info.thumbnail_url).toBeUndefined();
		expect(info.thumbnail_info).toMatchObject({ w: 800, h: 600, size: 500 });
	});

	it("throws when neither file nor contentUri is supplied (fail closed)", () => {
		expect(() =>
			buildMediaContent({
				kind: "file",
				filename: "doc.pdf",
				mimetype: "application/pdf",
				size: 10,
			}),
		).toThrow(/exactly one of file/i);
	});

	it("throws when both file and contentUri are supplied", () => {
		expect(() =>
			buildMediaContent({
				kind: "image",
				contentUri: "mxc://srv/abc",
				file: encFile("full"),
				filename: "cat.png",
				mimetype: "image/png",
				size: 1,
			}),
		).toThrow(/exactly one of file/i);
	});

	it("throws when a thumbnail has neither file nor contentUri", () => {
		expect(() =>
			buildMediaContent({
				kind: "image",
				contentUri: "mxc://srv/full",
				filename: "big.jpg",
				mimetype: "image/jpeg",
				size: 9000,
				thumbnail: { mimetype: "image/jpeg", size: 500, w: 800, h: 600 },
			}),
		).toThrow(/thumbnail must have exactly one/i);
	});

	it("attaches a reply relation (relation only, no body prefix)", () => {
		const replyTo = {
			eventId: "$reply",
			senderId: "@a:b",
			body: "hi",
		} as unknown as TimelineEvent;
		const c = buildMediaContent({
			kind: "image",
			contentUri: "mxc://srv/abc",
			filename: "cat.png",
			mimetype: "image/png",
			size: 1,
			replyTo,
		}) as unknown as Record<string, unknown>;
		expect(c["m.relates_to"]).toEqual({
			"m.in_reply_to": { event_id: "$reply" },
		});
		// Body is not prefixed with quote lines.
		expect(c.body).toBe("cat.png");
	});
});

describe("buildMediaContent voice notes", () => {
	it("emits the MSC3245 marker blocks and info.duration", () => {
		const c = buildMediaContent({
			kind: "audio",
			contentUri: "mxc://x/voice",
			filename: "Voice message.ogg",
			mimetype: "audio/ogg",
			size: 4200,
			voice: { durationMs: 6541, waveform: [0, 512, 1024] },
		}) as unknown as Record<string, unknown>;
		expect(c.msgtype).toBe("m.audio");
		expect((c.info as Record<string, unknown>).duration).toBe(6541);
		expect(c["org.matrix.msc3245.voice"]).toEqual({});
		expect(c["org.matrix.msc1767.audio"]).toEqual({
			duration: 6541,
			waveform: [0, 512, 1024],
		});
		// MSC1767 text fallback mirrors the body.
		expect(c["org.matrix.msc1767.text"]).toBe(c.body);
	});

	it("emits no voice blocks for a plain audio attachment", () => {
		const c = buildMediaContent({
			kind: "audio",
			contentUri: "mxc://x/song",
			filename: "song.mp3",
			mimetype: "audio/mpeg",
			size: 999,
		}) as unknown as Record<string, unknown>;
		expect(c["org.matrix.msc3245.voice"]).toBeUndefined();
		expect(c["org.matrix.msc1767.audio"]).toBeUndefined();
		expect((c.info as Record<string, unknown>).duration).toBeUndefined();
	});

	it("keeps voice blocks alongside an encrypted file source", () => {
		const c = buildMediaContent({
			kind: "audio",
			file: {
				url: "mxc://x/cipher",
				key: {
					k: "k",
					alg: "A256CTR",
					ext: true,
					key_ops: ["encrypt", "decrypt"],
					kty: "oct",
				},
				iv: "iv",
				hashes: { sha256: "h" },
				v: "v2",
			},
			filename: "Voice message.ogg",
			mimetype: "audio/ogg",
			size: 4200,
			voice: { durationMs: 1200, waveform: [512] },
		}) as unknown as Record<string, unknown>;
		expect(c.file).toBeTruthy();
		expect(c.url).toBeUndefined();
		expect(c["org.matrix.msc3245.voice"]).toEqual({});
	});
});
