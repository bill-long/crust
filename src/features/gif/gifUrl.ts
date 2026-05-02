/** Known GIF provider CDN URL patterns. */
const GIF_URL_PATTERNS: readonly RegExp[] = [
	// Giphy: media.giphy.com, media0-4.giphy.com
	/^https:\/\/media[0-4]?\.giphy\.com\//,
	// Klipy
	/^https:\/\/static\.klipy\.com\//,
	// Tenor (for receiving GIFs from other clients)
	/^https:\/\/(?:media|c)\.tenor\.com\//,
];

/** Check if a URL is a known GIF provider CDN URL. */
export function isGifUrl(url: string): boolean {
	return GIF_URL_PATTERNS.some((re) => re.test(url));
}

/**
 * Extract a GIF CDN URL from a plain-text message body.
 * Matches when the message body (after stripping Matrix reply fallback)
 * is a single GIF URL with no other content. Validates structure with
 * the URL constructor and requires a meaningful pathname.
 */
export function extractGifUrl(body: string): string | null {
	// Strip Matrix reply fallback: lines starting with "> " until the first
	// non-quoted line (the reply prefix format is "> <@user> text\n\n")
	let stripped = body;
	if (stripped.startsWith("> ")) {
		const endOfQuote = stripped.indexOf("\n\n");
		stripped = endOfQuote >= 0 ? stripped.slice(endOfQuote + 2) : stripped;
	}

	const trimmed = stripped.trim();
	if (!isGifUrl(trimmed) || /\s/.test(trimmed)) return null;

	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "https:") return null;
		if (parsed.pathname.length <= 1) return null;
	} catch {
		return null;
	}

	return trimmed;
}
