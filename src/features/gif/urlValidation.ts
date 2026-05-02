/** Validate that a URL uses the https: scheme. */
export function isValidHttpsUrl(url: string): boolean {
	try {
		return new URL(url).protocol === "https:";
	} catch {
		return false;
	}
}
