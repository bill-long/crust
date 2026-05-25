import { stripReplyFallback } from "./replyFallback";

/** Maximum number of preview cards rendered per message. */
export const MAX_PREVIEWS_PER_MESSAGE = 3;

/** Skip preview fetch + linkification for any URL longer than this. */
export const MAX_URL_LENGTH = 2048;

/**
 * Match bare http(s):// URLs. Uses a generous character class for the
 * URL body (anything that isn't whitespace, a control character, or a
 * known terminator like quotes / angle brackets). Trailing punctuation
 * and unbalanced parens are stripped in a post-processing step (see
 * `trimUrlTail`) rather than baked into the regex, because regex-only
 * solutions for balanced parens are unreliable.
 *
 * The `g` flag is used so callers can iterate matches; create a fresh
 * regex per call to avoid `lastIndex` state.
 */
export function urlRegex(): RegExp {
	return /\bhttps?:\/\/[^\s<>"'`{}|\\^[\]]+/gi;
}

/**
 * Strip trailing punctuation from a URL match. Handles two cases:
 *   1. Single trailing punctuation that's almost always prose, not URL:
 *      `.`, `,`, `;`, `:`, `!`, `?`, `>`, `"`, `'`, `]`, `}`.
 *   2. Unbalanced closing paren: `https://en.wikipedia.org/wiki/Foo_(bar)`
 *      keeps its `)`, but `(see https://example.com).` drops `).`.
 *
 * Iterates until the URL is balanced and free of trailing prose
 * punctuation.
 */
export function trimUrlTail(url: string): string {
	let s = url;
	while (s.length > 0) {
		const last = s[s.length - 1];
		if (last === ")") {
			const open = (s.match(/\(/g) ?? []).length;
			const close = (s.match(/\)/g) ?? []).length;
			if (close > open) {
				s = s.slice(0, -1);
				continue;
			}
			break;
		}
		if (/[.,;:!?>"'\]}]/.test(last)) {
			s = s.slice(0, -1);
			continue;
		}
		break;
	}
	return s;
}

/**
 * Canonicalize a URL for cache keying.
 *
 * - Parses via the URL constructor (rejects malformed).
 * - Allows only http(s) schemes (everything else is filtered out earlier;
 *   this is defense in depth).
 * - Drops the fragment so `https://x/p#a` and `https://x/p#b` share a
 *   cache entry.
 * - Keeps the query string and preserves percent-encoding as the parser
 *   normalizes it.
 *
 * Returns null when the URL is invalid or too long.
 */
export function canonicalizeUrl(url: string): string | null {
	if (url.length > MAX_URL_LENGTH) return null;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return null;
		}
		parsed.hash = "";
		parsed.hostname = parsed.hostname.replace(/\.+$/, "");
		return parsed.toString();
	} catch {
		return null;
	}
}

/**
 * Hosts whose URLs are Matrix permalinks (mentions, room links, event
 * links) rather than third-party content. We must never generate
 * OpenGraph preview cards for these — every user mention in
 * `formatted_body` is rendered as an `<a href="https://matrix.to/#/...">`
 * by the SDK, so fetching previews would spam each message with a
 * generic "You're invited to talk on Matrix" card per mention.
 *
 * Matches the bare hostname only (no subdomain wildcarding); matrix.to
 * is the spec-defined permalink host. Both Element and Cinny apply the
 * same exclusion.
 */
const NON_PREVIEWABLE_HOSTS = new Set(["matrix.to"]);

/**
 * True iff a (canonicalized) URL is eligible for OpenGraph preview
 * fetching. Filters Matrix permalink hosts so mentions and reply
 * permalinks don't produce preview cards. The URL must already be
 * canonical (i.e. result of `canonicalizeUrl`).
 */
export function isPreviewableUrl(canonical: string): boolean {
	try {
		const host = new URL(canonical).hostname.toLowerCase();
		return !NON_PREVIEWABLE_HOSTS.has(host);
	} catch {
		return false;
	}
}

/**
 * Remove fenced code blocks (```...```) and inline code spans (`...`)
 * from a plain-text body. Returns the body with those regions replaced
 * by spaces so URLs inside them aren't matched by `urlRegex`.
 *
 * Replacing with spaces (rather than empty string) preserves line/column
 * positions so any future caller that needs them stays correct.
 */
function stripCodeRegions(text: string): string {
	return text.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => " ".repeat(m.length));
}

/**
 * Extract URLs from a plain-text body, in order of first appearance,
 * deduped by canonical form, capped at `MAX_PREVIEWS_PER_MESSAGE`.
 *
 * Skips:
 *   - The Matrix reply-fallback quoted block (leading "> " lines).
 *   - Fenced code blocks and inline code spans.
 *   - URLs that fail canonicalization (malformed, non-http(s),
 *     longer than `MAX_URL_LENGTH`).
 */
export function extractUrlsFromText(body: string): string[] {
	const withoutReply = stripReplyFallback(body);
	const withoutCode = stripCodeRegions(withoutReply);
	const re = urlRegex();
	const seen = new Set<string>();
	const out: string[] = [];
	for (;;) {
		const match = re.exec(withoutCode);
		if (!match) break;
		const trimmed = trimUrlTail(match[0]);
		const canonical = canonicalizeUrl(trimmed);
		if (!canonical) continue;
		if (!isPreviewableUrl(canonical)) continue;
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		out.push(trimmed);
		if (out.length >= MAX_PREVIEWS_PER_MESSAGE) break;
	}
	return out;
}

// `MX-REPLY` wraps the quoted body of a Matrix rich reply; we skip
// that subtree so reply quotes don't generate previews for the
// original message. Generic `<blockquote>` is intentionally NOT
// excluded — user-authored quotes can preview just like normal
// content (matches `linkifyTextNodes`).
//
// SCRIPT/STYLE/NOSCRIPT/TEMPLATE/IFRAME/OBJECT/EMBED contain content
// that is stripped or never rendered by DOMPurify, so we must not
// produce previews from URLs that appear inside them — extracting
// here is called on raw `formatted_body` before sanitization, so the
// extractor must replicate the "what will actually render" filter.
const EXCLUDED_HTML_ANCESTORS = [
	"A",
	"CODE",
	"PRE",
	"MX-REPLY",
	"SCRIPT",
	"STYLE",
	"NOSCRIPT",
	"TEMPLATE",
	"IFRAME",
	"OBJECT",
	"EMBED",
];

function hasExcludedAncestor(node: Node): boolean {
	let cur: Node | null = node.parentNode;
	while (cur) {
		if (cur.nodeType === 1) {
			const tag = (cur as Element).tagName;
			if (EXCLUDED_HTML_ANCESTORS.includes(tag)) return true;
		}
		cur = cur.parentNode;
	}
	return false;
}

/**
 * Extract URLs from a Matrix `formatted_body`. Called on the raw
 * (pre-sanitization) HTML so previews stay aligned with what the user
 * authored; the `EXCLUDED_HTML_ANCESTORS` list mirrors the "not
 * rendered after sanitization" set (script/style/template/iframe/
 * object/embed) plus the always-skipped link/code/mx-reply subtrees.
 *
 * Collects URLs from two sources:
 *   1. `<a href>` attributes — these are author-anchored links.
 *   2. Bare URLs found in text nodes outside excluded subtrees.
 *
 * Excluded subtrees: see `EXCLUDED_HTML_ANCESTORS`. Note that generic
 * `<blockquote>` is intentionally NOT excluded — user-authored quotes
 * preview just like normal content (matches `linkifyTextNodes`).
 *
 * Same dedup + cap semantics as `extractUrlsFromText`.
 */
export function extractUrlsFromHtml(html: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];

	const doc = new DOMParser().parseFromString(html, "text/html");
	const root = doc.body;
	if (!root) return out;

	// Collect href attrs (but only on anchors not inside excluded ancestors
	// like mx-reply, where the quoted message's links shouldn't preview).
	for (const a of root.querySelectorAll("a")) {
		if (hasExcludedAncestor(a)) continue;
		const href = a.getAttribute("href");
		if (!href) continue;
		const canonical = canonicalizeUrl(href);
		if (!canonical) continue;
		if (!isPreviewableUrl(canonical)) continue;
		if (seen.has(canonical)) continue;
		seen.add(canonical);
		out.push(href);
		if (out.length >= MAX_PREVIEWS_PER_MESSAGE) return out;
	}

	// Walk text nodes for bare URLs that the sender didn't anchor.
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (;;) {
		const node = walker.nextNode() as Text | null;
		if (!node) break;
		if (hasExcludedAncestor(node)) continue;
		const text = node.nodeValue ?? "";
		const re = urlRegex();
		for (;;) {
			const match = re.exec(text);
			if (!match) break;
			const trimmed = trimUrlTail(match[0]);
			const canonical = canonicalizeUrl(trimmed);
			if (!canonical) continue;
			if (!isPreviewableUrl(canonical)) continue;
			if (seen.has(canonical)) continue;
			seen.add(canonical);
			out.push(trimmed);
			if (out.length >= MAX_PREVIEWS_PER_MESSAGE) return out;
		}
	}

	return out;
}
