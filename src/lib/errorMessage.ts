/**
 * User-facing message for a caught error.
 *
 * Browser/platform exceptions (DOMException from WebCrypto, TypeError from
 * fetch, ...) carry jargon that means nothing to users — show the curated
 * fallback instead. Server/SDK Errors (a MatrixError with the server's
 * message, e.g. "Invalid password") and our own curated Errors keep their
 * message, because those texts were written for humans.
 */
export function userFacingErrorMessage(e: unknown, fallback: string): string {
	if (e instanceof DOMException) return fallback;
	// fetch/network failures are TypeErrors with browser jargon
	// ("Failed to fetch") — never user-actionable.
	if (e instanceof TypeError) return fallback;
	if (e instanceof Error && e.message) return e.message;
	return fallback;
}
