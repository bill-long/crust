/** Recognize direct raster-image links without contacting the remote site. */
export function isImageLink(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			(url.protocol === "https:" || url.protocol === "http:") &&
			/\.(?:jpe?g|png|webp|gif|avif)$/i.test(url.pathname)
		);
	} catch {
		return false;
	}
}

/** Match production image CSP; insecure sources keep their external link fallback. */
export function imageViewerSource(
	sourceUrl: string,
	cachedUrl?: string | null,
): string | null {
	if (cachedUrl) {
		try {
			if (["https:", "blob:", "data:"].includes(new URL(cachedUrl).protocol))
				return cachedUrl;
		} catch {
			// Invalid cached metadata must not swallow the original link.
		}
	}
	return isImageLink(sourceUrl) && new URL(sourceUrl).protocol === "https:"
		? sourceUrl
		: null;
}
