/** Allowlisted image suffixes for files saved without an original filename. */
export function imageExtension(mime: string | null): string | null {
	const type = mime?.split(";", 1)[0]?.trim().toLowerCase();
	const extensions: Record<string, string> = {
		"image/png": "png",
		"image/apng": "apng",
		"image/jpeg": "jpg",
		"image/jpg": "jpg",
		"image/gif": "gif",
		"image/webp": "webp",
		"image/avif": "avif",
		"image/svg+xml": "svg",
		"image/bmp": "bmp",
		"image/x-icon": "ico",
		"image/vnd.microsoft.icon": "ico",
	};
	return type && Object.hasOwn(extensions, type)
		? (extensions[type] ?? null)
		: null;
}
