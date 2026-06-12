import { describe, expect, it } from "vitest";
import { makeThumbnail, probeImage } from "./imageProcessing";

/** Render a solid-colour image of the given size to a PNG blob. */
async function makeImageBlob(w: number, h: number): Promise<Blob> {
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("no 2d context");
	ctx.fillStyle = "#3366cc";
	ctx.fillRect(0, 0, w, h);
	return await new Promise<Blob>((resolve, reject) =>
		canvas.toBlob(
			(b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
			"image/png",
		),
	);
}

describe("probeImage", () => {
	it("returns intrinsic dimensions", async () => {
		const blob = await makeImageBlob(640, 480);
		expect(await probeImage(blob)).toEqual({ width: 640, height: 480 });
	});
});

describe("makeThumbnail", () => {
	it("returns null when the image already fits the box", async () => {
		const blob = await makeImageBlob(400, 300);
		expect(await makeThumbnail(blob, { w: 800, h: 600 })).toBeNull();
	});

	it("downscales a large image while preserving aspect ratio", async () => {
		const blob = await makeImageBlob(1600, 1200);
		const thumb = await makeThumbnail(blob, { w: 800, h: 600 });
		expect(thumb).not.toBeNull();
		if (!thumb) return;
		expect(thumb.width).toBe(800);
		expect(thumb.height).toBe(600);
		expect(thumb.blob.size).toBeGreaterThan(0);
		// Source was PNG → thumbnail keeps PNG to preserve any alpha.
		expect(thumb.mimetype).toBe("image/png");
	});
});
