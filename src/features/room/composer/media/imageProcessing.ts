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

/**
 * Result of inspecting an image for upload: its intrinsic dimensions plus an
 * optional downscaled thumbnail (`null` when the image already fits the box).
 */
export interface ImageInspection {
	width: number;
	height: number;
	thumbnail: Thumbnail | null;
}

/**
 * Decode an image once to read its intrinsic dimensions and, when it exceeds
 * the thumbnail box, render a downscaled thumbnail from the same bitmap. The
 * thumbnail is JPEG unless the source has an alpha-capable format (PNG/WebP),
 * which we keep as PNG to preserve transparency.
 */
export async function inspectImage(
	file: Blob,
	max: { w: number; h: number } = THUMBNAIL_MAX,
): Promise<ImageInspection> {
	const bitmap = await createImageBitmap(file);
	const width = bitmap.width;
	const height = bitmap.height;

	// Fits the box → no separate thumbnail; the full upload is its own thumb.
	if (width <= max.w && height <= max.h) {
		bitmap.close();
		return { width, height, thumbnail: null };
	}

	const scale = Math.min(max.w / width, max.h / height);
	const tw = Math.max(1, Math.round(width * scale));
	const th = Math.max(1, Math.round(height * scale));

	const useOffscreen = typeof OffscreenCanvas !== "undefined";
	let canvas: HTMLCanvasElement | OffscreenCanvas;
	if (useOffscreen) {
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
		return { width, height, thumbnail: null };
	}
	ctx.drawImage(bitmap, 0, 0, tw, th);
	bitmap.close();

	// PNG/WebP/GIF can carry transparency; encode their thumbnails as PNG so we
	// don't flatten alpha onto an opaque background.
	const keepAlpha =
		file.type === "image/png" ||
		file.type === "image/webp" ||
		file.type === "image/gif";
	const mimetype = keepAlpha ? "image/png" : "image/jpeg";

	let blob: Blob;
	// Guard the `instanceof` with the same capability flag — referencing
	// OffscreenCanvas directly would throw a ReferenceError where it's undefined.
	if (useOffscreen && canvas instanceof OffscreenCanvas) {
		blob = await canvas.convertToBlob({ type: mimetype, quality: 0.85 });
	} else {
		const el = canvas as HTMLCanvasElement;
		blob = await new Promise<Blob>((resolve, reject) => {
			el.toBlob(
				(b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
				mimetype,
				0.85,
			);
		});
	}

	return {
		width,
		height,
		thumbnail: { blob, width: tw, height: th, mimetype },
	};
}
