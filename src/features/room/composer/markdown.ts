/**
 * Simple inline markdown → HTML converter for Matrix formatted_body.
 * Handles: **bold**, *italic*, _italic_, `code`, ```code blocks```
 *
 * body is always raw user text (never escaped).
 * formatted_body is HTML with markdown transforms, or null if no
 * formatting was applied.
 */

export interface FormatResult {
	body: string;
	formatted_body: string | null;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function formatMarkdown(text: string): FormatResult {
	const body = text;

	let html = escapeHtml(text);

	// Extract code blocks and inline code to protect from further formatting
	const protectedBlocks: string[] = [];
	const PH = "\uFFFD";
	// Escape any existing placeholder chars so they can't collide
	html = html.replaceAll(PH, "&#xFFFD;");
	html = html.replace(/```\n?([\s\S]*?)```/g, (_, code) => {
		protectedBlocks.push(`<pre><code>${code}</code></pre>`);
		return `${PH}${protectedBlocks.length - 1}${PH}`;
	});
	html = html.replace(/`([^`]+)`/g, (_, code) => {
		protectedBlocks.push(`<code>${code}</code>`);
		return `${PH}${protectedBlocks.length - 1}${PH}`;
	});

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
	let hasFormatting = protectedBlocks.length > 0;
	if (!hasFormatting) {
		const plainHtml = escapeHtml(text).replace(/\n/g, "<br>");
		hasFormatting = html !== plainHtml;
	}

	return { body, formatted_body: hasFormatting ? html : null };
}
