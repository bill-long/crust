/** Recognize direct image URLs; HTTP images keep normal navigation under our CSP. */
export function isImageLink(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			/\.(?:jpe?g|png|webp|gif|avif)$/i.test(url.pathname)
		);
	} catch {
		return false;
	}
}
