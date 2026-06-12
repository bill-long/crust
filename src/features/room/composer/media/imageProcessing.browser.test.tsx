import { describe, expect, it } from "vitest";
import { inspectImage } from "./imageProcessing";

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

describe("inspectImage", () => {
	it("returns intrinsic dimensions and no thumbnail when it fits the box", async () => {
		const blob = await makeImageBlob(640, 480);
		const result = await inspectImage(blob, { w: 800, h: 600 });
		expect(result.width).toBe(640);
		expect(result.height).toBe(480);
		expect(result.thumbnail).toBeNull();
	});

	it("downscales a large image while preserving aspect ratio", async () => {
		const blob = await makeImageBlob(1600, 1200);
		const result = await inspectImage(blob, { w: 800, h: 600 });
		// Source dimensions are reported even when a thumbnail is produced.
		expect(result.width).toBe(1600);
		expect(result.height).toBe(1200);
		const thumb = result.thumbnail;
		expect(thumb).not.toBeNull();
		if (!thumb) return;
		expect(thumb.width).toBe(800);
		expect(thumb.height).toBe(600);
		expect(thumb.blob.size).toBeGreaterThan(0);
		// Source was PNG → thumbnail keeps PNG to preserve any alpha.
		expect(thumb.mimetype).toBe("image/png");
	});
});
