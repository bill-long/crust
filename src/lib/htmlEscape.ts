/**
 * Shared HTML-escaping helpers used by both the send path
 * (`composer/markdown.ts`) and the receive/render path (`emoji/MessageBody.tsx`).
 * Keeping a single audited implementation avoids the two paths drifting and
 * constructing HTML with inconsistent escaping rules.
 */

/** Escape the characters unsafe in HTML text content (and `"` for convenience). */
export function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Escape only the characters unsafe inside a double-quoted attribute value. */
export function escapeAttr(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
