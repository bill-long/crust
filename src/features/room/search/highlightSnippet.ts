import DOMPurify from "dompurify";
import { stripReplyFallback } from "../urlPreviews/replyFallback";

/** Half-window (in characters) on each side of the first match. */
const WINDOW_BEFORE = 60;
const WINDOW_AFTER = 180;

const HTML_ESCAPE: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch] ?? ch);
}

/** RegExp.escape isn't widely available yet; do it ourselves. */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a sanitized HTML snippet around the first match of any of the
 * supplied terms within `body`. The returned string is safe to assign to
 * `innerHTML`: only `<mark>` survives DOMPurify, with no attributes.
 *
 * - Reply-fallback `> ` lines are stripped first (snippets shouldn't
 *   bleed into the quoted prefix).
 * - Term matching is case-insensitive; longest terms are tried first so
 *   shorter substrings don't gobble part of a longer match.
 * - When no term matches, the leading window of the body is returned
 *   without highlights (the server may have stemmed the match).
 */
export function buildSnippetHtml(body: string, terms: string[]): string {
	const stripped = stripReplyFallback(body ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (stripped.length === 0) return "";

	const cleanedTerms = Array.from(
		new Set(
			terms.map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 100),
		),
	).sort((a, b) => b.length - a.length);

	const lower = stripped.toLowerCase();
	let firstMatch = -1;
	for (const term of cleanedTerms) {
		const idx = lower.indexOf(term.toLowerCase());
		if (idx !== -1 && (firstMatch === -1 || idx < firstMatch)) {
			firstMatch = idx;
		}
	}

	const center = firstMatch === -1 ? 0 : firstMatch;
	const start = Math.max(0, center - WINDOW_BEFORE);
	const end = Math.min(stripped.length, center + WINDOW_AFTER);
	const slice = stripped.slice(start, end);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < stripped.length ? "…" : "";

	let html = `${prefix}${escapeHtml(slice)}${suffix}`;

	// Collect every term match against the escaped HTML, merge overlapping
	// ranges, then splice <mark> tags right-to-left so earlier insertions
	// don't shift later indices. This avoids the naive sequential-replace
	// trap where shorter terms re-match inside an already-wrapped longer
	// term and produce nested <mark><mark>...</mark></mark> tags.
	const ranges: Array<[number, number]> = [];
	for (const term of cleanedTerms) {
		const re = new RegExp(escapeRegex(escapeHtml(term)), "gi");
		for (const m of html.matchAll(re)) {
			if (typeof m.index !== "number") continue;
			ranges.push([m.index, m.index + m[0].length]);
		}
	}
	if (ranges.length > 0) {
		ranges.sort((a, b) => a[0] - b[0]);
		const merged: Array<[number, number]> = [ranges[0]];
		for (let i = 1; i < ranges.length; i++) {
			const last = merged[merged.length - 1];
			const cur = ranges[i];
			if (cur[0] <= last[1]) {
				last[1] = Math.max(last[1], cur[1]);
			} else {
				merged.push(cur);
			}
		}
		for (let i = merged.length - 1; i >= 0; i--) {
			const [s, e] = merged[i];
			html = `${html.slice(0, s)}<mark>${html.slice(s, e)}</mark>${html.slice(e)}`;
		}
	}

	return DOMPurify.sanitize(html, {
		ALLOWED_TAGS: ["mark"],
		ALLOWED_ATTR: [],
	});
}
