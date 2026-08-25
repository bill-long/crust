import DOMPurify from "dompurify";
import type { MatrixClient } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	Show,
} from "solid-js";
import { canonicalizeUrl, trimUrlTail, urlRegex } from "../../lib/extractUrls";
import { escapeAttr, escapeHtml } from "../../lib/htmlEscape";
import { linkifyTextNodes } from "../../lib/linkify";
import { stripReplyFallback } from "../../lib/replyFallback";
import type { ResolvedEmote } from "./types";

// Configure DOMPurify once with Matrix-safe allowlist
const ALLOWED_TAGS = [
	"font",
	"del",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"p",
	"a",
	"ul",
	"ol",
	"sup",
	"sub",
	"li",
	"b",
	"i",
	"u",
	"strong",
	"em",
	"strike",
	"s",
	"code",
	"hr",
	"br",
	"div",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
	"caption",
	"pre",
	"span",
	"img",
	"details",
	"summary",
	"mx-reply",
];

const ALLOWED_ATTR = [
	"data-mx-bg-color",
	"data-mx-color",
	"data-mx-emoticon",
	"data-mx-maths",
	"data-mx-spoiler",
	"color",
	"name",
	"target",
	"href",
	"src",
	"alt",
	"title",
	"width",
	"height",
	"data-mx-pill",
	"start",
	"colspan",
	"rowspan",
];

// Allow mxc:// scheme in URI attributes so DOMPurify doesn't strip img src,
// and matrix: so in-spec `matrix:u/...` permalinks survive to the click
// router (see PermalinkRouting, issue #441).
const ALLOWED_URI_REGEXP =
	/^(?:(?:https?|mxc|mailto|tel|xmpp|geo|magnet|matrix):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

/** Build a shortcode regex (Safari-safe, no lookbehind). */
function shortcodeRegex(): RegExp {
	return /(^|[^:\w]):([a-zA-Z0-9_-]{2,50}):(?![\w:])/g;
}

/**
 * Sanitize Matrix HTML formatted_body, rewrite mxc:// URLs to HTTP,
 * and replace :shortcode: in text nodes with custom emoji images.
 */
function sanitizeMatrixHtml(
	html: string,
	client: MatrixClient,
	shortcodeLookup: Map<string, ResolvedEmote>,
): string {
	const clean = DOMPurify.sanitize(html, {
		ALLOWED_TAGS,
		ALLOWED_ATTR,
		ALLOW_DATA_ATTR: false,
		ADD_ATTR: [
			"data-mx-emoticon",
			"data-mx-bg-color",
			"data-mx-color",
			"data-mx-pill",
			"data-mx-maths",
			"data-mx-spoiler",
		],
		ALLOWED_URI_REGEXP,
	});

	const div = document.createElement("div");
	div.innerHTML = clean;

	// Strip the legacy in-band rich-reply fallback. The `m.in_reply_to` relation
	// now drives the quoted reply context (see `ReplyContext` in TimelineItem),
	// so rendering the `<mx-reply>` block here too would show the quote twice.
	// Mirrors how the plain-text `> ` fallback is stripped in `plainTextToHtml`.
	// Remove the whole node (with its blockquote children), not just the tag.
	for (const reply of div.querySelectorAll("mx-reply")) {
		reply.remove();
	}

	// Process images: only keep data-mx-emoticon with mxc:// src (strip tracking pixels)
	for (const img of div.querySelectorAll("img")) {
		const src = img.getAttribute("src");
		const isEmoticon = img.hasAttribute("data-mx-emoticon");
		if (!isEmoticon || !src?.startsWith("mxc://")) {
			img.remove();
			continue;
		}
		const httpUrl = client.mxcUrlToHttp(src, 64, 64, "scale");
		if (httpUrl) {
			img.setAttribute("src", httpUrl);
		} else {
			img.remove();
			continue;
		}
		img.classList.add("emoji-inline");
	}

	// Make all links open in new tab
	for (const a of div.querySelectorAll("a")) {
		a.setAttribute("target", "_blank");
		a.setAttribute("rel", "noopener noreferrer");
	}

	// Linkify bare URLs in text nodes (Crust's markdown layer doesn't
	// auto-anchor them). Done before shortcode replacement so that the
	// shortcode walker's existing skip-inside-`<a>` rule prevents emoji
	// substitution inside URL anchors.
	linkifyTextNodes(div);

	// Replace :shortcode: in text nodes only (not attributes)
	if (shortcodeLookup.size > 0) {
		replaceShortcodesInTextNodes(div, shortcodeLookup, client);
	}

	// Spoilers (MSC2010): [data-mx-spoiler] becomes a click-to-reveal
	// control. Runs LAST so anchors created by the linkify pass inside
	// spoiler content also get de-focused below. Content moves into an
	// inner aria-hidden wrapper so screen readers don't read it until
	// revealed; the reveal itself is handled by MessageBody's delegated
	// click/keydown (static innerHTML can't carry handlers). The
	// attribute's value is the optional reason. The index attribute keys
	// reveal state that must survive an innerHTML regeneration.
	let spoilerIdx = 0;
	for (const el of div.querySelectorAll("[data-mx-spoiler]")) {
		const reason = el.getAttribute("data-mx-spoiler");
		const content = document.createElement("span");
		content.className = "spoiler-content";
		content.setAttribute("aria-hidden", "true");
		let spoiler: Element;
		if (el.tagName === "IMG") {
			// A spoilered image (e.g. a custom emoticon - MSC2010 allows
			// the attribute on images): an <img> can't host the reveal
			// control or the content wrapper itself, so wrap it.
			spoiler = document.createElement("span");
			el.replaceWith(spoiler);
			content.appendChild(el);
		} else {
			spoiler = el;
			while (el.firstChild) content.appendChild(el.firstChild);
		}
		spoiler.appendChild(content);
		spoiler.classList.add("spoiler");
		spoiler.setAttribute("role", "button");
		spoiler.setAttribute("tabindex", "0");
		spoiler.setAttribute("aria-expanded", "false");
		spoiler.setAttribute(
			"aria-label",
			reason ? `Spoiler: ${reason}` : "Spoiler",
		);
		if (reason) spoiler.setAttribute("title", `Spoiler: ${reason}`);
		spoiler.setAttribute("data-spoiler-idx", String(spoilerIdx++));
		// aria-hidden content must not stay tab-reachable; the reveal
		// restores focusability.
		for (const a of content.querySelectorAll("a")) {
			a.setAttribute("tabindex", "-1");
		}
	}

	return div.innerHTML;
}

/**
 * Walk DOM text nodes and replace :shortcode: with <img> elements.
 * Skips text inside <code>, <pre>, and <a> elements.
 */
function replaceShortcodesInTextNodes(
	root: Node,
	shortcodeLookup: Map<string, ResolvedEmote>,
	client: MatrixClient,
): void {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];
	for (;;) {
		const node = walker.nextNode() as Text | null;
		if (!node) break;
		textNodes.push(node);
	}

	for (const textNode of textNodes) {
		// Skip text inside code/pre/a elements
		const parent = textNode.parentElement;
		if (
			parent?.closest("code") ||
			parent?.closest("pre") ||
			parent?.closest("a")
		) {
			continue;
		}

		const text = textNode.nodeValue;
		if (!text) continue;

		const re = shortcodeRegex();
		const fragments: (string | HTMLImageElement)[] = [];
		let lastIndex = 0;
		let hadMatch = false;

		for (;;) {
			const match = re.exec(text);
			if (!match) break;
			const prefix = match[1];
			const shortcode = match[2];
			const emote = shortcodeLookup.get(shortcode);
			if (!emote) continue;

			hadMatch = true;
			// Text before the match (including the prefix char)
			const beforeStart = lastIndex;
			const matchStart = match.index + prefix.length;
			if (beforeStart < matchStart) {
				fragments.push(text.slice(beforeStart, matchStart));
			}

			const img = document.createElement("img");
			img.className = "emoji-inline";
			img.setAttribute("data-mx-emoticon", "");
			img.src =
				client.mxcUrlToHttp(emote.mxcUrl, 64, 64, "scale") ?? emote.httpUrl;
			img.alt = `:${shortcode}:`;
			img.title = `:${shortcode}:`;
			fragments.push(img);

			lastIndex = match.index + match[0].length;
		}

		if (!hadMatch) continue;

		// Remaining text after last match
		if (lastIndex < text.length) {
			fragments.push(text.slice(lastIndex));
		}

		// Replace the text node with the fragments
		const parentNode = textNode.parentNode;
		if (!parentNode) continue;
		for (const frag of fragments) {
			if (typeof frag === "string") {
				parentNode.insertBefore(document.createTextNode(frag), textNode);
			} else {
				parentNode.insertBefore(frag, textNode);
			}
		}
		parentNode.removeChild(textNode);
	}
}

/**
 * Convert plain text body to inline HTML. Performs (in order):
 *   1. Strip Matrix reply-fallback (leading `> ` lines).
 *   2. Protect fenced/inline code regions with a sentinel placeholder.
 *   3. Linkify bare http(s) URLs (placeholder-protected so neither HTML
 *      escaping nor shortcode replacement re-enters them).
 *   4. Escape HTML in remaining text and apply `:shortcode:` emoji
 *      replacement.
 *   5. Restore code blocks (escaped) and anchors (raw HTML).
 *   6. Convert `\n` to `<br>`.
 *
 * Returns `null` when nothing was rewritten so callers can fall back to
 * a plain `<p>` render that preserves whitespace and avoids the
 * additional DOM wrapping.
 */
function plainTextToHtml(
	text: string,
	shortcodeLookup: Map<string, ResolvedEmote>,
): string | null {
	const stripped = stripReplyFallback(text);
	const wasStripped = stripped !== text;

	// Strip any pre-existing sentinel characters from user input before
	// inserting our own. Without this, a message like "a\uFFFF0\uFFFFb"
	// could collide with a code-block placeholder.
	let processed = stripped.replace(/[\uFFFE\uFFFF]/g, "");

	const CODE_SENT = "\uFFFF";
	const ANCHOR_SENT = "\uFFFE";

	const codeBlocks: string[] = [];
	processed = processed.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
		const idx = codeBlocks.length;
		codeBlocks.push(match);
		return `${CODE_SENT}${idx}${CODE_SENT}`;
	});

	const anchors: string[] = [];
	processed = processed.replace(urlRegex(), (match) => {
		const trimmed = trimUrlTail(match);
		if (!trimmed) return match;
		const canonical = canonicalizeUrl(trimmed);
		if (!canonical) return match;
		const idx = anchors.length;
		// `canonical` validates the URL and rejects non-http(s) schemes,
		// but we render `trimmed` in both href and visible text so we
		// preserve user fragments (`#section`) and the rendered form
		// matches what the user typed.
		anchors.push(
			`<a href="${escapeAttr(trimmed)}" target="_blank" rel="noreferrer noopener">${escapeHtml(trimmed)}</a>`,
		);
		const trailing = match.slice(trimmed.length);
		return `${ANCHOR_SENT}${idx}${ANCHOR_SENT}${trailing}`;
	});

	const hasAnchors = anchors.length > 0;
	const hasShortcodeMatch =
		shortcodeLookup.size > 0 && shortcodeRegex().test(processed);
	if (!hasAnchors && !hasShortcodeMatch) {
		// If the reply fallback was stripped, we must still render the
		// stripped body — otherwise the `<Show fallback>` path would
		// render `props.body` and re-expose the quote preamble. For
		// messages that weren't stripped, return null so the caller's
		// `whitespace-pre-wrap` fallback handles whitespace exactly.
		if (!wasStripped) return null;
		return escapeHtml(stripped).replace(/\n/g, "<br>");
	}

	const splitRe = new RegExp(
		`(${CODE_SENT}\\d+${CODE_SENT}|${ANCHOR_SENT}\\d+${ANCHOR_SENT})`,
		"g",
	);
	const codeOnlyRe = new RegExp(`^${CODE_SENT}(\\d+)${CODE_SENT}$`);
	const anchorOnlyRe = new RegExp(`^${ANCHOR_SENT}(\\d+)${ANCHOR_SENT}$`);

	const parts = processed.split(splitRe);
	const result: string[] = [];

	for (const part of parts) {
		const codeMatch = part.match(codeOnlyRe);
		if (codeMatch) {
			const idx = Number.parseInt(codeMatch[1], 10);
			result.push(idx < codeBlocks.length ? escapeHtml(codeBlocks[idx]) : "");
			continue;
		}
		const anchorMatch = part.match(anchorOnlyRe);
		if (anchorMatch) {
			const idx = Number.parseInt(anchorMatch[1], 10);
			result.push(idx < anchors.length ? anchors[idx] : "");
			continue;
		}

		let escaped = escapeHtml(part);
		if (hasShortcodeMatch) {
			escaped = escaped.replace(
				shortcodeRegex(),
				(match, prefix: string, shortcode: string) => {
					const emote = shortcodeLookup.get(shortcode);
					if (emote) {
						return `${prefix}<img class="emoji-inline" data-mx-emoticon src="${escapeAttr(emote.httpUrl)}" alt=":${escapeAttr(shortcode)}:" title=":${escapeAttr(shortcode)}:" />`;
					}
					return match;
				},
			);
		}
		result.push(escaped);
	}

	return result.join("").replace(/\n/g, "<br>");
}

/**
 * Apply the revealed state to one spoiler control: expanded, content out
 * of aria-hidden, and its anchors focusable again.
 */
function applyReveal(spoiler: Element): void {
	spoiler.classList.add("revealed");
	spoiler.setAttribute("aria-expanded", "true");
	const content = spoiler.querySelector(".spoiler-content");
	content?.removeAttribute("aria-hidden");
	for (const a of content?.querySelectorAll('a[tabindex="-1"]') ?? []) {
		a.removeAttribute("tabindex");
	}
}

/**
 * Renders a message body: sanitized HTML for formatted_body, or plain text
 * with :shortcode: replacement for custom emoji.
 */
const MessageBody: Component<{
	body: string;
	format: string | null;
	formattedBody: string | null;
	isEdited: boolean;
	client: MatrixClient;
	shortcodeLookup: Map<string, ResolvedEmote>;
}> = (props) => {
	const renderedHtml = createMemo(() => {
		// Prefer formatted_body when format is org.matrix.custom.html
		if (props.format === "org.matrix.custom.html" && props.formattedBody) {
			return sanitizeMatrixHtml(
				props.formattedBody,
				props.client,
				props.shortcodeLookup,
			);
		}

		// Plain text — try shortcode replacement
		return plainTextToHtml(props.body, props.shortcodeLookup);
	});

	// Revealed spoilers, keyed by data-spoiler-idx. Kept OUTSIDE the
	// rendered HTML: the innerHTML regenerates whenever the memo's inputs
	// change (notably the shortcodeLookup Map identity when image packs
	// finish loading, or an edit), and a reveal held only as a CSS class
	// would silently snap back to hidden.
	const [revealedSpoilers, setRevealedSpoilers] = createSignal<
		ReadonlySet<string>
	>(new Set());
	let htmlRef: HTMLDivElement | undefined;
	createEffect(() => {
		renderedHtml();
		const revealed = revealedSpoilers();
		const root = htmlRef;
		if (!root || revealed.size === 0) return;
		for (const spoiler of root.querySelectorAll(".spoiler")) {
			const idx = spoiler.getAttribute("data-spoiler-idx");
			if (idx !== null && revealed.has(idx)) applyReveal(spoiler);
		}
	});

	// One-way spoiler reveal (Discord-style), delegated: the sanitized
	// innerHTML can't carry handlers, so clicks/keys on the generated
	// .spoiler controls are caught on the container.
	const onSpoilerActivate = (e: MouseEvent | KeyboardEvent): void => {
		if (
			e instanceof KeyboardEvent &&
			e.key !== "Enter" &&
			e.key !== " " &&
			e.key !== "Spacebar"
		) {
			return;
		}
		const target = e.target;
		if (!(target instanceof Element)) return;
		const spoiler = target.closest(".spoiler");
		if (!spoiler || spoiler.classList.contains("revealed")) return;
		e.preventDefault();
		e.stopPropagation();
		applyReveal(spoiler);
		const idx = spoiler.getAttribute("data-spoiler-idx");
		if (idx !== null) {
			setRevealedSpoilers((prev) => new Set(prev).add(idx));
		}
	};

	return (
		<Show
			when={renderedHtml()}
			fallback={
				<p class="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-text-secondary">
					{props.body}
					<Show when={props.isEdited}>
						<span class="ml-1 text-xs text-text-disabled">(edited)</span>
					</Show>
				</p>
			}
		>
			{(html) => (
				<div class="message-body break-words [overflow-wrap:anywhere] text-sm text-text-secondary">
					{/* biome-ignore lint/a11y/noStaticElementInteractions: passive delegate for the sanitizer-generated role="button" spoiler spans inside the static innerHTML, which cannot carry handlers themselves */}
					<div
						ref={htmlRef}
						innerHTML={html()}
						onClick={onSpoilerActivate}
						onKeyDown={onSpoilerActivate}
					/>
					<Show when={props.isEdited}>
						<span class="ml-1 text-xs text-text-disabled">(edited)</span>
					</Show>
				</div>
			)}
		</Show>
	);
};

export { MessageBody };
