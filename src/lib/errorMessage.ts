/**
 * The server's own `error` body when `e` is a Matrix API error, detected
 * structurally (an Error carrying a string `errcode`) rather than via
 * `instanceof MatrixError` - tests partially mocking matrix-js-sdk would
 * otherwise break this module. Null when `e` is not a Matrix API error;
 * empty string when it is one but carries no human text.
 */
function matrixServerText(e: Error): string | null {
	const err = e as { errcode?: unknown; data?: { error?: unknown } };
	if (typeof err.errcode !== "string") return null;
	const text = err.data?.error;
	return typeof text === "string" ? text : "";
}

/**
 * User-facing message for a caught error.
 *
 * Browser/platform exceptions (DOMException from WebCrypto, TypeError from
 * fetch, ...) carry jargon that means nothing to users — show the curated
 * fallback instead. Server/SDK Errors and our own curated Errors keep
 * their human-written text: for a MatrixError that is the server's own
 * `error` body ("Invalid password"), not the SDK's composed message,
 * which wraps it in noise ("MatrixError: [401] ... (https://...)").
 */
export function userFacingErrorMessage(e: unknown, fallback: string): string {
	if (e instanceof DOMException) return fallback;
	// fetch/network failures are TypeErrors with browser jargon
	// ("Failed to fetch") — never user-actionable.
	if (e instanceof TypeError) return fallback;
	if (e instanceof Error) {
		const serverText = matrixServerText(e);
		if (serverText !== null) return serverText || fallback;
		if (e.message) return e.message;
	}
	return fallback;
}
