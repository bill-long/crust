/**
 * Markdown → HTML converter for Matrix `formatted_body`.
 *
 * Block constructs (headings, blockquotes, ordered/unordered lists, fenced
 * code) are detected line-by-line on the RAW text — before HTML-escaping — so
 * their leading markers (`#`, `>`, `-`, `1.`) aren't mangled into entities
 * (`>` → `&gt;`). Each line's inline content (bold, italic, strikethrough,
 * inline code, links, @mentions, `:custom-emoji:`) is then rendered by
 * `formatInline`.
 *
 * `body` is always the raw user text (never escaped). `formatted_body` is the
 * rendered HTML, or `null` when nothing was formatted, so the caller can omit
 * `format`/`formatted_body` and send a plain message.
 *
 * The emitted tags (b/strong, em/i, del, code, pre, a, h1–h6, blockquote,
 * ul/ol/li, img, br) must stay within `MessageBody`'s DOMPurify allowlist so
 * Crust's own renderer round-trips them; Element parses the same set.
 */

import { escapeAttr, escapeHtml } from "./htmlEscape";

export { escapeHtml };

export interface Mention {
	userId: string;
	displayName: string;
}

export interface CustomEmoji {
	shortcode: string;
	mxcUrl: string;
}

export interface FormatResult {
	body: string;
	formatted_body: string | null;
}

/** Regex-escape a string for literal use in `new RegExp`. */
function reEscape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fail-closed link gate: only `http`, `https`, and `mailto` URLs become
 * anchors. Anything else (e.g. `javascript:`) renders as literal text. The
 * receive-side DOMPurify allowlist re-validates, but the sender must never
 * emit an unsafe href in the first place.
 */
function isSafeLinkUrl(url: string): boolean {
	try {
		const { protocol } = new URL(url);
		return (
			protocol === "http:" || protocol === "https:" || protocol === "mailto:"
		);
	} catch {
		return false;
	}
}

/**
 * Sentinel that fences off already-rendered fragments from later passes. We
 * use U+FFFF — a permanent Unicode noncharacter that never appears in real
 * text — rather than U+FFFD (the replacement char), which legitimately shows
 * up in user input from decoding errors. `formatMarkdown` strips U+FFFF from
 * the input below so it can't collide with our `PH<idx>PH` tokens; because
 * U+FFFF never appears in real text, dropping it loses nothing the plain
 * `body` keeps. U+FFFD is deliberately left intact so the HTML and plaintext
 * renderings stay in sync. Mirrors the receive-side sentinels in
 * `plainTextToHtml` (`MessageBody.tsx`).
 */
const PH = "￿";

interface InlineContext {
	mentions: Mention[];
	customEmoji: CustomEmoji[];
	/** Rendered fragments hidden behind `${PH}<idx>${PH}` placeholders. */
	protectedBlocks: string[];
	/** OR-accumulated across every line to decide if `formatted_body` is needed. */
	flags: { mention: boolean; emoji: boolean; inline: boolean };
}

/** Stash a rendered fragment and return its placeholder token. */
function protect(ctx: InlineContext, html: string): string {
	const idx = ctx.protectedBlocks.length;
	ctx.protectedBlocks.push(html);
	return `${PH}${idx}${PH}`;
}

/**
 * Render the inline markdown of a single line (no newlines). Order matters:
 * code spans and links are protected on the RAW text (so escaping and emphasis
 * can't reach inside them, and link URLs keep their `&`/`#`), then the
 * remainder is escaped, then mentions/emoji are protected, then emphasis runs.
 */
function formatInline(line: string, ctx: InlineContext): string {
	let s = line;

	// Inline code spans (raw → escaped content, protected).
	s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
		ctx.flags.inline = true;
		return protect(ctx, `<code>${escapeHtml(code)}</code>`);
	});

	// Markdown links [text](url) — validated on the raw URL so query `&` and
	// `#fragment` survive. Fail closed for unsafe schemes.
	s = s.replace(
		/\[([^\]\n]+)\]\(([^)\s]+)\)/g,
		(m, text: string, url: string) => {
			if (!isSafeLinkUrl(url)) return m;
			ctx.flags.inline = true;
			return protect(
				ctx,
				`<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(text)}</a>`,
			);
		},
	);

	// Escape the remaining text; placeholder tokens (`PH<digits>PH`) contain
	// only the sentinel and digits, so escaping leaves them untouched.
	s = escapeHtml(s);

	// Mentions @DisplayName → permalink pill. Boundary-checked on both sides
	// (no lookbehind, for Safari). Protect so emphasis can't reach inside.
	for (const mention of ctx.mentions) {
		const escapedName = escapeHtml(`@${mention.displayName}`);
		const pattern = new RegExp(
			`(^|[^\\w])${reEscape(escapedName)}(?!\\w)`,
			"g",
		);
		const permalink = `https://matrix.to/#/${encodeURIComponent(mention.userId)}`;
		const token = protect(
			ctx,
			`<a href="${escapeAttr(permalink)}">${escapedName}</a>`,
		);
		let matched = false;
		s = s.replace(pattern, (_m, prefix: string) => {
			matched = true;
			return prefix + token;
		});
		if (matched) ctx.flags.mention = true;
		else ctx.protectedBlocks.pop();
	}

	// Custom emoji :shortcode: → <img data-mx-emoticon>.
	for (const ce of ctx.customEmoji) {
		const pattern = new RegExp(
			`(^|[^:\\w]):${reEscape(ce.shortcode)}:(?![\\w:])`,
			"g",
		);
		const img = `<img data-mx-emoticon height="32" src="${escapeHtml(ce.mxcUrl)}" alt=":${escapeHtml(ce.shortcode)}:" title=":${escapeHtml(ce.shortcode)}:" />`;
		const token = protect(ctx, img);
		let matched = false;
		s = s.replace(pattern, (_m, prefix: string) => {
			matched = true;
			return prefix + token;
		});
		if (matched) ctx.flags.emoji = true;
		else ctx.protectedBlocks.pop();
	}

	// Emphasis on the escaped text. Bold before italic so `**x**` wins.
	const beforeEmphasis = s;
	s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
	s = s.replace(/~~(.+?)~~/g, "<del>$1</del>");
	s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
	s = s.replace(/(^|[^\w])_(.+?)_(?!\w)/g, "$1<em>$2</em>");
	if (s !== beforeEmphasis) ctx.flags.inline = true;

	return s;
}

export function formatMarkdown(
	text: string,
	mentions: Mention[] = [],
	customEmoji: CustomEmoji[] = [],
): FormatResult {
	const body = text;

	const ctx: InlineContext = {
		mentions,
		customEmoji,
		protectedBlocks: [],
		flags: { mention: false, emoji: false, inline: false },
	};

	// Drop any user-typed sentinel so it can't collide with our placeholders.
	let src = text.replaceAll(PH, "");

	// Extract fenced code blocks first (multi-line) so their inner `#`/`>`/`-`
	// lines aren't mistaken for block markers. Content is escaped; the optional
	// info string (language) after the opening fence is dropped.
	src = src.replace(
		/```(?:[^\n]*\n)([\s\S]*?)```|```([\s\S]*?)```/g,
		(_m, withLang: string | undefined, inline: string | undefined) => {
			ctx.flags.inline = true;
			return protect(
				ctx,
				`<pre><code>${escapeHtml(withLang ?? inline ?? "")}</code></pre>`,
			);
		},
	);

	const lines = src.split("\n");
	const out: string[] = [];
	let textRun: string[] = [];
	let blockApplied = false;

	const flushText = (): void => {
		if (textRun.length > 0) {
			out.push(textRun.map((l) => formatInline(l, ctx)).join("<br>"));
			textRun = [];
		}
	};

	const UL_RE = /^[-*+][ \t]+(.+)$/;
	const OL_RE = /^(\d{1,9})[.)][ \t]+(.+)$/;
	const QUOTE_RE = /^>[ \t]?/;

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		const heading = /^(#{1,6})[ \t]+(.+)$/.exec(line);
		if (heading) {
			flushText();
			const level = heading[1].length;
			out.push(`<h${level}>${formatInline(heading[2], ctx)}</h${level}>`);
			blockApplied = true;
			i++;
			continue;
		}

		if (QUOTE_RE.test(line)) {
			flushText();
			const quoted: string[] = [];
			while (i < lines.length && QUOTE_RE.test(lines[i])) {
				quoted.push(formatInline(lines[i].replace(QUOTE_RE, ""), ctx));
				i++;
			}
			out.push(`<blockquote>${quoted.join("<br>")}</blockquote>`);
			blockApplied = true;
			continue;
		}

		if (UL_RE.test(line)) {
			flushText();
			const items: string[] = [];
			for (let m = UL_RE.exec(lines[i]); m; m = UL_RE.exec(lines[i] ?? "")) {
				items.push(`<li>${formatInline(m[1], ctx)}</li>`);
				i++;
				if (i >= lines.length) break;
			}
			out.push(`<ul>${items.join("")}</ul>`);
			blockApplied = true;
			continue;
		}

		const ol = OL_RE.exec(line);
		if (ol) {
			flushText();
			const startNum = Number(ol[1]);
			const items: string[] = [];
			for (let m = OL_RE.exec(lines[i]); m; m = OL_RE.exec(lines[i] ?? "")) {
				items.push(`<li>${formatInline(m[2], ctx)}</li>`);
				i++;
				if (i >= lines.length) break;
			}
			const startAttr = startNum !== 1 ? ` start="${startNum}"` : "";
			out.push(`<ol${startAttr}>${items.join("")}</ol>`);
			blockApplied = true;
			continue;
		}

		textRun.push(line);
		i++;
	}
	flushText();

	// Restore all protected fragments.
	const html = out
		.join("")
		.replace(new RegExp(`${PH}(\\d+)${PH}`, "g"), (m, idx: string) => {
			const n = Number(idx);
			return n < ctx.protectedBlocks.length ? ctx.protectedBlocks[n] : m;
		});

	const hasFormatting =
		blockApplied || ctx.flags.inline || ctx.flags.mention || ctx.flags.emoji;

	return { body, formatted_body: hasFormatting ? html : null };
}
