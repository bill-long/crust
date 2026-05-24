/**
 * Validate and canonicalize a Matrix user ID typed by the user.
 *
 * Rules (per issue #71):
 *   - leading/trailing whitespace tolerated and trimmed
 *   - must start with "@"
 *   - must contain ":" after the localpart
 *   - localpart (between "@" and the first ":") must be non-empty
 *   - server portion must be non-empty AND parse as a valid host with no
 *     extra path/query/fragment/credentials (mirrors discovery.ts behavior)
 *
 * The first ":" after "@" splits localpart from server, so server portions
 * may legitimately contain additional colons (port numbers, IPv6 literals
 * like "[::1]:8008").
 */
export type ValidateUserIdResult =
	| { ok: true; userId: string }
	| { ok: false; error: string };

export function validateMatrixUserId(input: string): ValidateUserIdResult {
	const trimmed = input.trim();
	if (!trimmed) {
		return { ok: false, error: "Enter a Matrix user ID (e.g. @alice:server)." };
	}
	if (!trimmed.startsWith("@")) {
		return { ok: false, error: "User ID must start with @." };
	}

	const colonIdx = trimmed.indexOf(":", 1);
	if (colonIdx < 0) {
		return {
			ok: false,
			error: "User ID must include a server (e.g. @alice:server).",
		};
	}

	const localpart = trimmed.slice(1, colonIdx);
	if (!localpart) {
		return { ok: false, error: "User ID is missing a name before the ':'." };
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in user input.
	if (/[\s\x00-\x1f\x7f:]/.test(localpart)) {
		return {
			ok: false,
			error: "User ID name contains invalid characters.",
		};
	}

	const server = trimmed.slice(colonIdx + 1);
	if (!server) {
		return { ok: false, error: "User ID is missing a server after the ':'." };
	}

	// Reject characters that the URL parser would silently swallow or
	// normalize away (path/query/fragment separators, backslash, userinfo
	// markers, whitespace). Without this guard, inputs like "matrix.org/",
	// "/matrix.org", or "//evil.com" round-trip cleanly through `new URL`
	// because the parser strips the offending characters from `host`.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in user input.
	if (/[/?#\\@\s\x00-\x1f\x7f]/.test(server)) {
		return { ok: false, error: "Server portion is not a valid hostname." };
	}

	// Validate the server is a usable host with no extra URL components.
	// We round-trip through URL and require the canonical href to be exactly
	// `https://<host>/`. This single check rejects path / query / fragment /
	// userinfo injection AND tolerates the URL parser's default-port
	// normalization (e.g. `:443` is stripped from parsed.host).
	let parsed: URL;
	try {
		parsed = new URL(`https://${server}`);
	} catch {
		return { ok: false, error: "Server portion is not a valid hostname." };
	}
	if (parsed.href !== `https://${parsed.host}/` || parsed.host === "") {
		return { ok: false, error: "Server portion is not a valid hostname." };
	}

	return { ok: true, userId: trimmed };
}
