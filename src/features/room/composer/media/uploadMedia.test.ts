import type { MatrixClient } from "matrix-js-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../../../../test/mockClient";
import { EncryptedRoomUnsupportedError } from "./mediaContent";
import type { PendingAttachment } from "./types";
import { uploadAndSend, validateSize } from "./uploadMedia";

// Stub the canvas-backed helpers so the image path runs under jsdom.
vi.mock("./imageProcessing", () => ({
	THUMBNAIL_MAX: { w: 800, h: 600 },
	probeImage: vi.fn().mockResolvedValue({ width: 1600, height: 1200 }),
	makeThumbnail: vi.fn().mockResolvedValue({
		blob: new Blob(["thumb"], { type: "image/jpeg" }),
		width: 800,
		height: 600,
		mimetype: "image/jpeg",
	}),
}));

const ROOM = "!r:test";

function setup(opts?: { encrypted?: boolean; uploadSize?: number }) {
	const room = createMockRoom(ROOM, [], []);
	if (opts?.encrypted) room.__setEncrypted(true);
	const client = createMockClient(new Map([[ROOM, room]]));
	if (opts?.uploadSize !== undefined) {
		client.getMediaConfig = vi
			.fn()
			.mockResolvedValue({ "m.upload.size": opts.uploadSize });
	}
	return { room, client: client as unknown as MatrixClient };
}

function attachment(
	file: File,
	kind: PendingAttachment["kind"],
): PendingAttachment {
	return {
		id: "a1",
		file,
		kind,
		previewUrl: null,
		caption: "",
		status: "ready",
		progress: 0,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("validateSize", () => {
	it("rejects files over the server limit", async () => {
		const { client } = setup({ uploadSize: 100 });
		const big = new File([new Uint8Array(200)], "big.bin");
		await expect(validateSize(client, big)).rejects.toThrow(/too large/i);
	});

	it("passes when under the limit", async () => {
		const { client } = setup({ uploadSize: 1000 });
		const small = new File([new Uint8Array(10)], "small.bin");
		await expect(validateSize(client, small)).resolves.toBeUndefined();
	});

	it("passes when no limit is advertised", async () => {
		const { client } = setup();
		const f = new File([new Uint8Array(10)], "f.bin");
		await expect(validateSize(client, f)).resolves.toBeUndefined();
	});

	it("does not block when the media config fetch fails, and retries next time", async () => {
		const { client } = setup();
		const cfg = client.getMediaConfig as ReturnType<typeof vi.fn>;
		cfg.mockReset();
		cfg
			.mockRejectedValueOnce(new Error("network"))
			.mockResolvedValueOnce({ "m.upload.size": 5 });
		const f = new File([new Uint8Array(10)], "f.bin");
		// First call: config fetch failed → upload allowed (no cached "no limit").
		await expect(validateSize(client, f)).resolves.toBeUndefined();
		// Second call: config now succeeds and the file exceeds the limit.
		await expect(validateSize(client, f)).rejects.toThrow(/too large/i);
	});
});

describe("uploadAndSend", () => {
	it("uploads thumbnail + full image and sends an m.image", async () => {
		const { client } = setup();
		const upload = client.uploadContent as ReturnType<typeof vi.fn>;
		upload
			.mockResolvedValueOnce({ content_uri: "mxc://srv/thumb" })
			.mockResolvedValueOnce({ content_uri: "mxc://srv/full" });

		const file = new File([new Uint8Array(50)], "cat.png", {
			type: "image/png",
		});
		const progress: number[] = [];
		const content = (await uploadAndSend(
			client,
			ROOM,
			attachment(file, "image"),
			{
				onProgress: (p) => progress.push(p),
			},
		)) as unknown as Record<string, unknown>;

		expect(upload).toHaveBeenCalledTimes(2);
		expect(content.msgtype).toBe("m.image");
		expect(content.url).toBe("mxc://srv/full");
		const info = content.info as Record<string, unknown>;
		expect(info).toMatchObject({ w: 1600, h: 1200, size: 50 });
		expect(info.thumbnail_url).toBe("mxc://srv/thumb");
		expect(client.sendMessage).toHaveBeenCalledWith(ROOM, content);
		expect(progress.at(-1)).toBe(1);
	});

	it("sends a non-image file as m.file without a thumbnail", async () => {
		const { client } = setup();
		const file = new File([new Uint8Array(20)], "doc.pdf", {
			type: "application/pdf",
		});
		const content = (await uploadAndSend(
			client,
			ROOM,
			attachment(file, "file"),
		)) as unknown as Record<string, unknown>;

		expect(client.uploadContent).toHaveBeenCalledTimes(1);
		expect(content.msgtype).toBe("m.file");
		expect(
			(content.info as Record<string, unknown>).thumbnail_url,
		).toBeUndefined();
	});

	it("still sends the full image when the thumbnail upload fails (best-effort)", async () => {
		const { client } = setup();
		const upload = client.uploadContent as ReturnType<typeof vi.fn>;
		// First call is the thumbnail (rejects), second is the full image.
		upload
			.mockRejectedValueOnce(new Error("thumb upload failed"))
			.mockResolvedValueOnce({ content_uri: "mxc://srv/full" });

		const file = new File([new Uint8Array(50)], "cat.png", {
			type: "image/png",
		});
		const content = (await uploadAndSend(
			client,
			ROOM,
			attachment(file, "image"),
		)) as unknown as Record<string, unknown>;

		expect(content.msgtype).toBe("m.image");
		expect(content.url).toBe("mxc://srv/full");
		expect(
			(content.info as Record<string, unknown>).thumbnail_url,
		).toBeUndefined();
		expect(client.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("rejects sends to encrypted rooms", async () => {
		const { client } = setup({ encrypted: true });
		const file = new File([new Uint8Array(10)], "cat.png", {
			type: "image/png",
		});
		await expect(
			uploadAndSend(client, ROOM, attachment(file, "image")),
		).rejects.toBeInstanceOf(EncryptedRoomUnsupportedError);
		expect(client.uploadContent).not.toHaveBeenCalled();
		expect(client.sendMessage).not.toHaveBeenCalled();
	});
});
