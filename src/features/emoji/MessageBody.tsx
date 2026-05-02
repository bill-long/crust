import DOMPurify from "dompurify";
import type { MatrixClient } from "matrix-js-sdk";
import { type Component, createMemo, Show } from "solid-js";
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

// Allow mxc:// scheme in URI attributes so DOMPurify doesn't strip img src
const ALLOWED_URI_REGEXP =
	/^(?:(?:https?|mxc|mailto|tel|xmpp|geo|magnet):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

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
		],
		ALLOWED_URI_REGEXP,
	});

	const div = document.createElement("div");
	div.innerHTML = clean;

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

	// Replace :shortcode: in text nodes only (not attributes)
	if (shortcodeLookup.size > 0) {
		replaceShortcodesInTextNodes(div, shortcodeLookup, client);
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
 * Full plain-text-to-HTML conversion: escape HTML entities, convert newlines
 * to <br>, then apply shortcode replacement.
 */
function plainTextToHtml(
	text: string,
	shortcodeLookup: Map<string, ResolvedEmote>,
): string | null {
	if (shortcodeLookup.size === 0) return null;

	// Protect code blocks
	const codeBlocks: string[] = [];
	const SENTINEL = "\uFFFF";
	let processed = text.replace(/\uFFFF/g, "");

	processed = processed.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
		const idx = codeBlocks.length;
		codeBlocks.push(match);
		return `${SENTINEL}${idx}${SENTINEL}`;
	});

	// Check if any shortcodes would match before doing the full conversion
	const testRe = shortcodeRegex();
	if (!testRe.test(processed)) return null;

	// Escape HTML in the non-code parts, then replace shortcodes
	const parts = processed.split(
		new RegExp(`(${SENTINEL}\\d+${SENTINEL})`, "g"),
	);
	const result: string[] = [];

	for (const part of parts) {
		const sentinelMatch = part.match(
			new RegExp(`^${SENTINEL}(\\d+)${SENTINEL}$`),
		);
		if (sentinelMatch) {
			const idx = Number.parseInt(sentinelMatch[1], 10);
			result.push(idx < codeBlocks.length ? escapeHtml(codeBlocks[idx]) : "");
		} else {
			let escaped = escapeHtml(part);
			const re = shortcodeRegex();
			escaped = escaped.replace(
				re,
				(match, prefix: string, shortcode: string) => {
					const emote = shortcodeLookup.get(shortcode);
					if (emote) {
						return `${prefix}<img class="emoji-inline" data-mx-emoticon src="${escapeAttr(emote.httpUrl)}" alt=":${escapeAttr(shortcode)}:" title=":${escapeAttr(shortcode)}:" />`;
					}
					return match;
				},
			);
			result.push(escaped);
		}
	}

	return result.join("").replace(/\n/g, "<br>");
}

function escapeHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function escapeAttr(str: string): string {
	return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
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

	return (
		<Show
			when={renderedHtml()}
			fallback={
				<p class="whitespace-pre-wrap break-words text-sm text-neutral-300">
					{props.body}
					<Show when={props.isEdited}>
						<span class="ml-1 text-xs text-neutral-600">(edited)</span>
					</Show>
				</p>
			}
		>
			{(html) => (
				<div class="message-body whitespace-pre-wrap break-words text-sm text-neutral-300">
					<div innerHTML={html()} />
					<Show when={props.isEdited}>
						<span class="ml-1 text-xs text-neutral-600">(edited)</span>
					</Show>
				</div>
			)}
		</Show>
	);
};

export default MessageBody;
