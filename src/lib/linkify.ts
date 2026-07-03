import { canonicalizeUrl, trimUrlTail, urlRegex } from "./extractUrls";

/**
 * Tag names whose subtrees should NOT have bare URLs auto-linkified.
 *
 * Matches the convention used by Element / Cinny: links inside an
 * existing `<a>` (already anchored), inside `<code>`/`<pre>` (verbatim
 * text), and inside `<mx-reply>` (the quoted preamble of a reply) are
 * left alone. Note that `<blockquote>` is intentionally not excluded —
 * quoted text that isn't part of a reply fallback should still have
 * clickable URLs.
 */
const EXCLUDED_ANCESTORS = new Set(["A", "CODE", "PRE", "MX-REPLY"]);

function hasExcludedAncestor(node: Node): boolean {
	let cur: Node | null = node.parentNode;
	while (cur) {
		if (cur.nodeType === 1) {
			const tag = (cur as Element).tagName;
			if (EXCLUDED_ANCESTORS.has(tag)) return true;
		}
		cur = cur.parentNode;
	}
	return false;
}

/**
 * Walk text nodes under `root` and replace bare `http(s)://` URLs with
 * `<a target="_blank" rel="noreferrer noopener">` elements.
 *
 * Each anchor's `href` and link text are set via `setAttribute` /
 * `textContent`, so the platform performs all escaping — there is no
 * manual HTML concatenation. Trailing punctuation and unbalanced
 * parentheses are stripped via `trimUrlTail`; non-http(s) and malformed
 * matches are filtered via `canonicalizeUrl`.
 *
 * Mutates `root` in place.
 */
export function linkifyTextNodes(root: Node): void {
	const ownerDoc =
		(root.ownerDocument as Document | null | undefined) ??
		(root as Document).defaultView?.document ??
		document;
	const walker = ownerDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];
	for (;;) {
		const node = walker.nextNode() as Text | null;
		if (!node) break;
		textNodes.push(node);
	}

	interface Match {
		start: number;
		end: number;
		href: string;
	}

	for (const textNode of textNodes) {
		if (hasExcludedAncestor(textNode)) continue;
		const value = textNode.nodeValue;
		if (!value) continue;

		const matches: Match[] = [];
		const re = urlRegex();
		for (;;) {
			const m = re.exec(value);
			if (!m) break;
			const trimmed = trimUrlTail(m[0]);
			if (!trimmed) continue;
			if (!canonicalizeUrl(trimmed)) continue;
			matches.push({
				start: m.index,
				end: m.index + trimmed.length,
				href: trimmed,
			});
		}
		if (matches.length === 0) continue;

		const parentNode = textNode.parentNode;
		if (!parentNode) continue;

		let cursor = 0;
		for (const m of matches) {
			if (m.start > cursor) {
				parentNode.insertBefore(
					ownerDoc.createTextNode(value.slice(cursor, m.start)),
					textNode,
				);
			}
			const a = ownerDoc.createElement("a");
			a.setAttribute("href", m.href);
			a.setAttribute("target", "_blank");
			a.setAttribute("rel", "noreferrer noopener");
			a.textContent = m.href;
			parentNode.insertBefore(a, textNode);
			cursor = m.end;
		}
		if (cursor < value.length) {
			parentNode.insertBefore(
				ownerDoc.createTextNode(value.slice(cursor)),
				textNode,
			);
		}
		parentNode.removeChild(textNode);
	}
}
