/**
 * Simple inline markdown → HTML converter for Matrix formatted_body.
 * Handles: **bold**, *italic*, _italic_, `code`, ```code blocks```, @mentions,
 * custom emoji :shortcode:
 *
 * body is always raw user text (never escaped).
 * formatted_body is HTML with markdown transforms, or null if no
 * formatting was applied.
 */

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

export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function formatMarkdown(
	text: string,
	mentions?: Mention[],
	customEmoji?: CustomEmoji[],
): FormatResult {
	const body = text;

	let html = escapeHtml(text);

	// Extract code blocks and inline code to protect from further formatting
	const protectedBlocks: string[] = [];
	const PH = "\uFFFD";
	// Escape any existing placeholder chars so they can't collide
	html = html.replaceAll(PH, "&#xFFFD;");
	html = html.replace(
		/```(?:[^\n]*\n)([\s\S]*?)```|```([\s\S]*?)```/g,
		(_, codeWithLang, codeInline) => {
			protectedBlocks.push(
				`<pre><code>${codeWithLang ?? codeInline ?? ""}</code></pre>`,
			);
			return `${PH}${protectedBlocks.length - 1}${PH}`;
		},
	);
	html = html.replace(/`([^`]+)`/g, (_, code) => {
		protectedBlocks.push(`<code>${code}</code>`);
		return `${PH}${protectedBlocks.length - 1}${PH}`;
	});

	// Protect mentions with placeholders before markdown transforms
	let mentionsApplied = false;
	if (mentions && mentions.length > 0) {
		for (const mention of mentions) {
			const escapedName = escapeHtml(`@${mention.displayName}`);
			const permalink = `https://matrix.to/#/${encodeURIComponent(mention.userId)}`;
			const link = `<a href="${escapeHtml(permalink)}">${escapedName}</a>`;
			// Replace @DisplayName with both-side boundary check (no lookbehind for Safari)
			const escaped = escapeHtml(`@${mention.displayName}`).replace(
				/[.*+?^${}()|[\]\\]/g,
				"\\$&",
			);
			const boundaryPattern = new RegExp(`(^|[^\\w])${escaped}(?!\\w)`, "g");
			// Only add to protectedBlocks if replacement actually matches
			let matched = false;
			const placeholderIdx = protectedBlocks.length;
			protectedBlocks.push(link);
			const placeholder = `${PH}${placeholderIdx}${PH}`;
			html = html.replace(boundaryPattern, (_match, prefix) => {
				matched = true;
				return prefix + placeholder;
			});
			if (!matched) {
				protectedBlocks.pop();
			} else {
				mentionsApplied = true;
			}
		}
	}

	// Custom emoji :shortcode: → <img data-mx-emoticon>
	let customEmojiApplied = false;
	if (customEmoji && customEmoji.length > 0) {
		for (const ce of customEmoji) {
			const escapedSc = escapeHtml(ce.shortcode).replace(
				/[.*+?^${}()|[\]\\]/g,
				"\\$&",
			);
			// Safari compat: use capture-and-reinsert instead of lookbehind
			const safariPattern = new RegExp(
				`(^|[^:\\w]):${escapedSc}:(?![\\w:])`,
				"g",
			);
			const img = `<img data-mx-emoticon height="32" src="${escapeHtml(ce.mxcUrl)}" alt=":${escapeHtml(ce.shortcode)}:" title=":${escapeHtml(ce.shortcode)}:" />`;
			const placeholderIdx = protectedBlocks.length;
			protectedBlocks.push(img);
			const placeholder = `${PH}${placeholderIdx}${PH}`;
			let matched = false;
			html = html.replace(safariPattern, (_match, prefix) => {
				matched = true;
				return prefix + placeholder;
			});
			if (!matched) {
				protectedBlocks.pop();
			} else {
				customEmojiApplied = true;
			}
		}
	}

	// Bold (**...**) — must be before italic
	html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

	// Italic (*...*)
	html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

	// Italic (_..._) — only at word boundaries (no lookbehind for Safari compat)
	html = html.replace(/(^|[^\w])_(.+?)_(?!\w)/g, "$1<em>$2</em>");

	// Convert newlines to <br> before restoring code blocks so <pre> content
	// keeps real newlines while regular text gets line breaks
	html = html.replace(/\n/g, "<br>");

	// Restore protected blocks (code blocks preserve actual newlines inside <pre>)
	html = html.replace(new RegExp(`${PH}(\\d+)${PH}`, "g"), (match, idx) => {
		const i = Number(idx);
		return i < protectedBlocks.length ? protectedBlocks[i] : match;
	});

	// Track whether formatting was applied by comparing against plain escaped text
	const hasMentions = mentionsApplied;
	const hasCustomEmoji = customEmojiApplied;
	let hasFormatting = protectedBlocks.length > 0;
	if (!hasFormatting) {
		const plainHtml = escapeHtml(text)
			.replaceAll(PH, "&#xFFFD;")
			.replace(/\n/g, "<br>");
		hasFormatting = html !== plainHtml;
	}

	return {
		body,
		formatted_body:
			hasFormatting || hasMentions || hasCustomEmoji ? html : null,
	};
}
