/** Validate an absolute HTTPS URL with an explicit host. */
export function isValidHttpsUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			/^https:\/\/[^/]/i.test(url) &&
			parsed.protocol === "https:" &&
			parsed.hostname.length > 0
		);
	} catch {
		return false;
	}
}
