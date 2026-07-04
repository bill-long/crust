import { M_POLL_START, type MatrixEvent } from "matrix-js-sdk";
import { pollPreviewText } from "../../../lib/pollCopy";
import { stripReplyFallback } from "../../../lib/replyFallback";
import { isVoiceMessageContent } from "../../../lib/voiceMessage";
import type { SyntheticCallLeave } from "./stateNotice";
import type { TimelineEvent } from "./timelineTypes";

// ASCII control character (C0 range 0x00–0x1F, plus DEL 0x7F) — the single
// boundary both `hasControlChar` (reject) and `stripControlChars` (sanitize)
// key off, so the policy can't drift between them.
function isControlCharCode(c: number): boolean {
	return c < 0x20 || c === 0x7f;
}

// Reject any ASCII control character. Used to guard user-controlled strings
// that flow into UI labels (filenames, the lightbox header, download
// attributes, etc.) so a CR/LF/NUL/etc. can't corrupt rendering or downstream
// consumers.
export function hasControlChar(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		if (isControlCharCode(s.charCodeAt(i))) return true;
	}
	return false;
}

// Strip ASCII control chars from a single-line string destined for a UI label,
// leaving the rest intact. Unlike `hasControlChar` (which rejects wholesale),
// this sanitizes a snippet so a stray control char can't corrupt rendering
// while still showing the surrounding text. Newlines are control chars and so
// are removed — callers that want multi-line text use `sanitizeMultiline`.
function stripControlChars(s: string): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		if (!isControlCharCode(s.charCodeAt(i))) out += s[i];
	}
	return out;
}

// Sanitize multi-line user text (an image caption) for display: normalize
// CRLF/CR to LF and keep newlines (the caption renders with `whitespace-pre-wrap`)
// while stripping every other control char that could corrupt rendering.
export function sanitizeMultiline(s: string): string {
	const normalized = s.replace(/\r\n?/g, "\n");
	let out = "";
	for (let i = 0; i < normalized.length; i++) {
		const c = normalized.charCodeAt(i);
		if (c === 0x0a || !isControlCharCode(c)) out += normalized[i];
	}
	return out;
}

// Upper bound on a reply snippet's length so a huge parent body can't bloat
// the projection or the rendered quote line (which is also CSS-truncated).
const REPLY_SNIPPET_MAX = 100;

/**
 * Build a one-line snippet of a replied-to (parent) event for the quoted
 * reply-context block. Media parents get a short labelled placeholder (the
 * filename for files, a generic icon label otherwise) since their `body` is a
 * filename/caption, not prose; text/emote/notice parents get their first body
 * line with the reply fallback stripped. The result is control-char-stripped
 * and length-capped.
 */
export function buildReplySnippet(parent: MatrixEvent): string {
	const content = parent.getContent();
	const type = parent.getType();
	const msgtype = typeof content.msgtype === "string" ? content.msgtype : "";
	const filename =
		typeof content.filename === "string" && content.filename.trim().length > 0
			? content.filename.trim()
			: typeof content.body === "string" && content.body.trim().length > 0
				? content.body.trim()
				: null;
	let snippet: string;
	const pollPreview = M_POLL_START.matches(type)
		? pollPreviewText(content)
		: null;
	if (pollPreview) {
		snippet = pollPreview;
	} else if (type === "m.sticker") {
		snippet = "Sticker";
	} else if (msgtype === "m.image") {
		snippet = "📷 Image";
	} else if (msgtype === "m.video") {
		snippet = "🎬 Video";
	} else if (msgtype === "m.audio") {
		snippet = isVoiceMessageContent(content) ? "🎤 Voice message" : "🔊 Audio";
	} else if (msgtype === "m.file") {
		snippet = filename ? `📎 ${filename}` : "📎 File";
	} else {
		const body = typeof content.body === "string" ? content.body : "";
		// Only the first line is needed; avoid allocating a full split() array
		// for a potentially large parent body.
		const stripped = stripReplyFallback(body);
		const nl = stripped.indexOf("\n");
		snippet = (nl === -1 ? stripped : stripped.slice(0, nl)).trim();
	}
	snippet = stripControlChars(snippet).trim();
	return snippet.length > REPLY_SNIPPET_MAX
		? `${snippet.slice(0, REPLY_SNIPPET_MAX)}…`
		: snippet;
}

/**
 * Synthetic event-ID prefix for a "left the call" notice that has no backing
 * `MatrixEvent` (the membership lapsed by expiry). Real Matrix event IDs start
 * with `$`, so this `~` prefix can never collide, and the full key is stable
 * across rebuilds (same user + device + expiry) so the Solid store reconcile
 * and group-expansion state survive re-evaluation.
 */
const SYNTHETIC_CALL_LEAVE_PREFIX = "~call-expiry-leave:";

export function syntheticCallLeaveId(leave: SyntheticCallLeave): string {
	// userId (always) and deviceId (possibly) contain `:`, so encode each
	// variable segment to keep the key collision-free for Solid's reconcile.
	return `${SYNTHETIC_CALL_LEAVE_PREFIX}${encodeURIComponent(leave.userId)}:${encodeURIComponent(leave.deviceId)}:${leave.expiresAt}`;
}

export function isSyntheticEventId(eventId: string): boolean {
	return eventId.startsWith(SYNTHETIC_CALL_LEAVE_PREFIX);
}

/**
 * Trim the oldest rows from the live-append store until the number of real
 * (non-synthetic) rows is within `limit`. Synthetic expiry-leave rows are not
 * part of the `TimelineWindow` and so don't count toward its limit, but any
 * that fall within the trimmed leading run are removed too.
 */
export function capStoreToRealLimit(
	draft: TimelineEvent[],
	limit: number,
): void {
	let realCount = 0;
	for (const r of draft) if (!isSyntheticEventId(r.eventId)) realCount++;
	let excess = realCount - limit;
	if (excess <= 0) return;
	let cut = 0;
	while (cut < draft.length && excess > 0) {
		if (!isSyntheticEventId(draft[cut].eventId)) excess--;
		cut++;
	}
	if (cut > 0) draft.splice(0, cut);
}

/**
 * Two-pointer merge of `inserts` into `base`, both ascending by `timestamp`.
 * An insert sorts *after* any base row sharing its timestamp: a row is emitted
 * before `ev` only when its timestamp is strictly less than `ev.timestamp`, so
 * an insert equal to `ev` is deferred until the next strictly-greater base row
 * (or the tail, when it has no later base row). Returns a new array; neither
 * input is mutated. Used to splice synthetic expiry-leave notices into the
 * chronological displayable list at their anchor timestamp.
 */
export function mergeRowsByTimestamp(
	base: readonly TimelineEvent[],
	inserts: readonly TimelineEvent[],
): TimelineEvent[] {
	if (inserts.length === 0) return base.slice();
	const out: TimelineEvent[] = [];
	let i = 0;
	for (const ev of base) {
		while (i < inserts.length && inserts[i].timestamp < ev.timestamp) {
			out.push(inserts[i]);
			i++;
		}
		out.push(ev);
	}
	while (i < inserts.length) {
		out.push(inserts[i]);
		i++;
	}
	return out;
}
