import {
	hasControlChar,
	stripBidiControls,
	stripControlChars,
} from "./controlChars";

/** The label for an attachment with no usable name, everywhere one is shown. */
export const FALLBACK_FILENAME = "file";

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
