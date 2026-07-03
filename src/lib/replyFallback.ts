/**
 * Strip the Matrix plain-text reply fallback prefix.
 *
 * Per the Matrix spec, a reply fallback in `body` is shaped as:
 *
 * ```
 * > <@sender:server> first line of quoted body
 * > optional continuation lines
 * \n
 * actual reply text
 * ```
 *
 * See https://spec.matrix.org/v1.10/client-server-api/#fallbacks-for-rich-replies
 *
 * We match that exact shape (sender line in angle brackets + zero or
 * more `>`-prefixed lines + a blank line) rather than any leading
 * `> ` block. This matches Cinny's `trimReplyFromBody` heuristic and
 * avoids stripping legitimate user content that happens to start with
 * blockquote-style text.
 *
 * Returns the body with the fallback removed, or the unchanged body
 * when it doesn't match the spec shape.
 */
const REPLY_FALLBACK_RE = /^> <.+?> .+\n(>.*\n)*?\n/;

export function stripReplyFallback(body: string): string {
	const match = body.match(REPLY_FALLBACK_RE);
	if (!match) return body;
	return body.slice(match[0].length);
}
