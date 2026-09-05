import {
	hasControlChar,
	isControlCharCode,
	stripBidiControls,
	stripControlChars,
} from "./controlChars";
import { stripReplyFallback } from "./replyFallback";

/**
 * The name used for an attachment that has no usable one: the chip label,
 * the `download` attribute, an upload name, a forwarded body. A name, not a
 * caption - the reply snippet says "File" in prose and is not this.
 */
export const FALLBACK_FILENAME = "file";

/** Matrix attachment message types whose raw body needs filename projection. */
export function isAttachmentMsgtype(msgtype: unknown): boolean {
	return (
		msgtype === "m.image" ||
		msgtype === "m.video" ||
		msgtype === "m.audio" ||
		msgtype === "m.file"
	);
}

/**
 * Sanitize a file-provided name for use as a Matrix `filename`/`body`, as a
 * UI/ARIA label and as the `download` attribute: drop control characters (C0
 * and DEL, the one definition in `controlChars`), bidi scope controls and path
 * separators, trim surrounding whitespace, and fall back to "file" when
 * nothing usable remains.
 *
 * The bidi strip is the extension-spoofing guard: `invoice<RLO>gnp.exe`
 * renders as `invoiceexe.png` wherever the raw string lands as text. Chromium
 * sanitizes the saved name itself, so the exposure was the chip label and its
 * aria-label, which read this same string. Stripped rather than rejected, the
 * same choice the display-name policy makes for these characters; where the
 * two differ is a line breaker, which a name refuses and a filename merely
 * drops, because `invoicegnp.exe` is still an honest filename.
 */
export function sanitizeFilename(name: string | undefined | null): string {
	if (!name) return FALLBACK_FILENAME;
	const out = stripControlChars(stripBidiControls(name))
		.replace(/[/\\]/g, "")
		.trim();
	return out || FALLBACK_FILENAME;
}

/**
 * The receive-side rule for a wire `filename` or `body` about to be shown as a
 * filename: bidi scope controls stripped, trimmed, and refused wholesale on a
 * control character - a caption-style body with a newline in it is not a
 * filename, and a NUL would corrupt every label it reached. Returns null for
 * "no usable filename".
 *
 * `eventProjection` (the chip, lightbox header and export line) and the reply
 * snippet both derive their name through this, so they cannot disagree.
 */
export function wireFilename(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const trimmed = stripBidiControls(raw).trim();
	return trimmed.length > 0 && !hasControlChar(trimmed) ? trimmed : null;
}

function hasReplyRelation(content: Record<string, unknown>): boolean {
	const relatesTo = content["m.relates_to"] as
		| Record<string, Record<string, unknown> | undefined>
		| undefined;
	return (
		typeof relatesTo?.["m.in_reply_to"]?.event_id === "string" &&
		relatesTo["m.in_reply_to"].event_id.length > 0
	);
}

/**
 * Which of an attachment's `filename` and `body` names it, resolved through
 * {@link wireFilename}. The explicit `filename` wins whenever it has anything
 * in it after the bidi strip; only an empty or whitespace-only one yields to
 * `body`, which may carry a usable filename. A control-bearing explicit
 * filename does NOT yield - it is refused, and a caption-style body is not a
 * better filename than none. One rule, so the chip, the lightbox header, the
 * export line and the reply snippet cannot disagree about which string names
 * the attachment.
 */
export function wireAttachmentName(
	content: Record<string, unknown>,
): string | null {
	const explicit =
		typeof content.filename === "string"
			? stripBidiControls(content.filename).trim()
			: "";
	if (explicit.length > 0) return wireFilename(content.filename);
	const body =
		typeof content.body === "string" && hasReplyRelation(content)
			? stripReplyFallback(content.body)
			: content.body;
	return wireFilename(body);
}

/**
 * A distinct user-authored caption from Matrix attachment content. Spec-correct
 * sends put the filename in `filename` and the caption in `body`; without a
 * usable explicit filename, `body` is treated as the legacy filename instead.
 * Plain-text reply fallback and non-newline control characters are removed so
 * callers can render the result directly.
 */
export function wireAttachmentCaption(
	content: Record<string, unknown>,
): string | null {
	const filename = wireFilename(content.filename);
	if (filename === null || typeof content.body !== "string") return null;

	const normalized = content.body.replace(/\r\n?/g, "\n");
	let cleanBody = "";
	for (let i = 0; i < normalized.length; i++) {
		const code = normalized.charCodeAt(i);
		if (code === 0x0a || !isControlCharCode(code)) cleanBody += normalized[i];
	}

	const withoutFallback = stripReplyFallback(cleanBody);
	const formattedBody =
		typeof content.formatted_body === "string"
			? content.formatted_body.trimStart()
			: "";
	const hasFormattedReplyFallback =
		content.format === "org.matrix.custom.html" &&
		/^<mx-reply(?:\s|>)/i.test(formattedBody);
	const strippedCaption = withoutFallback.trim();
	// A relation alone does not prove the plain prefix is transport metadata:
	// Crust's media replies carry a relation without a fallback, so an authored
	// caption may legitimately begin with the same syntax. Rich reply HTML proves
	// a fallback is present; an exact post-strip filename also proves that the
	// prefix is not authored caption text.
	const shouldStripFallback =
		hasReplyRelation(content) &&
		withoutFallback !== cleanBody &&
		(hasFormattedReplyFallback ||
			stripBidiControls(strippedCaption) === filename);
	const caption = (shouldStripFallback ? strippedCaption : cleanBody).trim();

	return caption.length > 0 && stripBidiControls(caption) !== filename
		? caption
		: null;
}
