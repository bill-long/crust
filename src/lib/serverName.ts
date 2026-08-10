/**
 * Validate a Matrix server name typed by a user or received in a link.
 *
 * Shared by user-ID validation (`inviteValidation.ts`) and room-address
 * parsing (`joinAddressParsing.ts`) so every entry point enforces the
 * same host rules.
 *
 * Rejects characters that the URL parser would silently swallow or
 * normalize away (path/query/fragment separators, backslash, userinfo
 * markers, whitespace, control chars). Without that guard, inputs like
 * "matrix.org/", "/matrix.org", or "//evil.com" round-trip cleanly
 * through `new URL` because the parser strips the offending characters
 * from `host`. Then round-trips through URL and requires the canonical
 * href to be exactly `https://<host>/` - a single check that rejects
 * path / query / fragment / userinfo injection AND tolerates the URL
 * parser's default-port normalization (e.g. `:443` is stripped from
 * parsed.host). Server portions may legitimately contain additional
 * colons (port numbers, IPv6 literals like "[::1]:8008").
 */
export function isValidServerName(server: string): boolean {
	if (!server) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional - reject control chars in user input.
	if (/[/?#\\@\s\x00-\x1f\x7f]/.test(server)) return false;
	let parsed: URL;
	try {
		parsed = new URL(`https://${server}`);
	} catch {
		return false;
	}
	return parsed.href === `https://${parsed.host}/` && parsed.host !== "";
}
