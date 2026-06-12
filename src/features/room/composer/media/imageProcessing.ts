/**
 * Canvas-backed image helpers. Isolated here so the rest of the media
 * pipeline (classification, content building, upload orchestration) stays
 * free of DOM/canvas dependencies and unit-testable without a browser.
 */

/** Maximum thumbnail box. Mirrors the size the timeline requests for inline images. */
export const THUMBNAIL_MAX = { w: 800, h: 600 } as const;

/** Generated thumbnail blob plus its scaled dimensions. */
export interface Thumbnail {
	blob: Blob;
	width: number;
	height: number;
	mimetype: string;
}

/** Probe an image file's intrinsic pixel dimensions. */
export async function probeImage(
	file: Blob,
): Promise<{ width: number; height: number }> {
	const bitmap = await createImageBitmap(file);
	try {
		return { width: bitmap.width, height: bitmap.height };
	} finally {
		bitmap.close();
	}
}

/**
 * Produce a downscaled thumbnail for an image that exceeds the thumbnail box.
 * Returns `null` when the image already fits (the full upload doubles as its
 * own thumbnail in that case). Output is JPEG unless the source has an alpha
 * channel format (PNG/WebP), which we keep as PNG to preserve transparency.
 */
export async function makeThumbnail(
	file: Blob,
	max: { w: number; h: number } = THUMBNAIL_MAX,
): Promise<Thumbnail | null> {
	const { width, height } = await probeImage(file);
	if (width <= max.w && height <= max.h) return null;

	const scale = Math.min(max.w / width, max.h / height);
	const tw = Math.max(1, Math.round(width * scale));
	const th = Math.max(1, Math.round(height * scale));

	const bitmap = await createImageBitmap(file);
	let canvas: HTMLCanvasElement | OffscreenCanvas;
	if (typeof OffscreenCanvas !== "undefined") {
		canvas = new OffscreenCanvas(tw, th);
	} else {
		canvas = document.createElement("canvas");
		canvas.width = tw;
		canvas.height = th;
	}
	const ctx = canvas.getContext("2d") as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D
		| null;
	if (!ctx) {
		bitmap.close();
		return null;
	}
	ctx.drawImage(bitmap, 0, 0, tw, th);
	bitmap.close();

	const keepAlpha = file.type === "image/png" || file.type === "image/webp";
	const mimetype = keepAlpha ? "image/png" : "image/jpeg";

	let blob: Blob;
	if (canvas instanceof OffscreenCanvas) {
		blob = await canvas.convertToBlob({ type: mimetype, quality: 0.85 });
	} else {
		blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob(
				(b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
				mimetype,
				0.85,
			);
		});
	}

	return { blob, width: tw, height: th, mimetype };
}
