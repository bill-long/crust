import {
	ClientEvent,
	Direction,
	EventStatus,
	type EventTimeline,
	type EventTimelineSet,
	M_POLL_START,
	type MatrixClient,
	type MatrixEvent,
	MatrixEventEvent,
	type Room,
	RoomEvent,
	type RoomMember,
	RoomMemberEvent,
	TimelineWindow,
} from "matrix-js-sdk";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import {
	createServerTimeTracker,
	MATERIAL_OFFSET_CHANGE_MS,
} from "../../../client/serverTime";
import { CALL_MEMBER_EVENT_TYPE } from "../../../client/summaries";
import { pollPreviewText } from "../../../lib/pollCopy";
import { isThreadReply } from "../../../lib/threadEvents";
import {
	isVoiceMessageContent,
	parseVoiceInfo,
} from "../../../lib/voiceMessage";
import { extractGifUrl } from "../../gif/gifUrl";
import {
	type EncryptedFileInfo,
	parseEncryptedFile,
} from "../composer/media/attachmentCrypto";
import { type PollSnapshot, parsePollStart } from "../poll/pollSnapshot";
import { createPollWatcher, type PollWatcher } from "../poll/pollWatcher";
import type { ThreadSummary } from "../threads/threadSummary";
import {
	createThreadWatcher,
	type ThreadWatcher,
} from "../threads/threadWatcher";
import {
	mainTimelineSource,
	type TimelineSource,
} from "../threads/timelineSource";
import { stripReplyFallback } from "../urlPreviews/replyFallback";
import type {
	MembershipTransition,
	StateNotice,
	SyntheticCallLeave,
} from "./stateNotice";
import {
	buildMembershipTransition,
	buildStateNotice,
	computeCallTimelineNotices,
	isStateNoticeType,
} from "./stateNotice";

/**
 * Aggregated reaction data for a single key on a single message.
 *
 * `senders` holds one entry per unique reactor (deduped by user ID),
 * with the display name already resolved at aggregation time so the
 * render path does not need a per-pill member lookup. `count` and
 * `senders.length` are always equal — they're computed in the same
 * dedupe pass so the tooltip and pill count can never disagree.
 */
export interface ReactionAggregate {
	count: number;
	senders: { userId: string; name: string }[];
}

export interface TimelineEvent {
	eventId: string;
	senderId: string;
	senderName: string;
	timestamp: number;
	type: string;
	msgtype: string;
	body: string;
	format: string | null;
	formattedBody: string | null;
	/**
	 * Scaled (thumbnail) http URL of the media, for the inline `<img>` of an
	 * `m.image` / `m.sticker` / GIF row. Only meaningful for images; the
	 * video / audio / file renderers use {@link TimelineEvent.mediaFullUrl}
	 * instead. Null when the content has no usable mxc URL.
	 */
	mediaUrl: string | null;
	/**
	 * Intrinsic pixel dimensions of the media, parsed from
	 * `content.info.w` / `content.info.h` for `m.image` / `m.sticker` /
	 * `m.video` events (and GIF-URL `m.text`). Used by the renderer to
	 * reserve layout space *before* the media loads — eliminates the
	 * "row grows on load" jump that confuses the virtualizer on hard refresh.
	 * Null when either dimension is missing, non-numeric, non-finite,
	 * or non-positive.
	 */
	mediaWidth: number | null;
	mediaHeight: number | null;
	/**
	 * Full-resolution http URL of the media, built from the same mxc URI
	 * as {@link TimelineEvent.mediaUrl} but without scale/thumb params. For
	 * images it's the lightbox source; for `m.video` / `m.audio` / `m.file`
	 * it's the bytes the player loads or the download fetches; for an encrypted
	 * `m.sticker` it's the ciphertext the renderer decrypts. Populated for the
	 * attachment msgtypes (`m.image` / `m.video` / `m.audio` / `m.file`) and
	 * `m.sticker` — NOT for GIF text. The image lightbox gallery keys off
	 * `msgtype === "m.image"`, so stickers and gif rows are excluded from it
	 * regardless. Null when the content has no usable mxc URL. When
	 * {@link TimelineEvent.mediaIsEncrypted}, this points at *ciphertext*.
	 */
	mediaFullUrl: string | null;
	/**
	 * Scaled (thumbnail) http poster URL for an `m.video`, from
	 * `content.info.thumbnail_url`. Only populated for *plain* video (an
	 * encrypted `thumbnail_file` is ciphertext and isn't decoded here). Null
	 * otherwise.
	 */
	mediaPosterUrl: string | null;
	/** Mimetype from `content.info.mimetype`, e.g. `"image/png"`. */
	mediaMimetype: string | null;
	/** Byte size from `content.info.size`, when present. */
	mediaSize: number | null;
	/**
	 * User-facing filename: prefers `content.filename` (newer Matrix
	 * spec), falls back to `content.body` when it looks like a filename
	 * (non-empty, contains no newlines). Null otherwise.
	 */
	mediaFilename: string | null;
	/**
	 * Caption text for an `m.image`, taken from `content.body` when the
	 * send carried an explicit `content.filename` *and* `body` differs from
	 * it (the spec-correct shape: filename in `filename`, caption in `body`).
	 * Null when there is no separate caption (no `filename`, or `body`
	 * equals the filename). Control chars are stripped; multi-line captions
	 * are preserved. Only populated for `m.image`.
	 */
	mediaCaption: string | null;
	/**
	 * Ciphertext http URL of an encrypted `m.video`'s thumbnail, resolved
	 * from `info.thumbnail_file.url`. Points at *ciphertext*: the renderer
	 * downloads + decrypts it (via {@link createDecryptedObjectUrl}) for a
	 * poster, or fails open to no poster — never renders it directly. Null
	 * for plain video (which uses {@link TimelineEvent.mediaPosterUrl}) and
	 * non-video events.
	 */
	mediaThumbnailUrl: string | null;
	/**
	 * Validated EncryptedFile descriptor for an encrypted `m.video`'s
	 * thumbnail (`info.thumbnail_file`), used to decrypt the poster. Null
	 * when absent or malformed (the poster then simply doesn't render —
	 * poster decode is best-effort and never blocks playback).
	 */
	mediaThumbnailFile: EncryptedFileInfo | null;
	/** Plaintext mimetype of the encrypted thumbnail, from `info.thumbnail_info.mimetype`. */
	mediaThumbnailMimetype: string | null;
	/**
	 * True when the attachment is encrypted (source was `content.file`, not
	 * `content.url`). When set, {@link TimelineEvent.mediaUrl} /
	 * {@link TimelineEvent.mediaFullUrl} point at *ciphertext*: consumers must
	 * download + decrypt it (via {@link TimelineEvent.mediaEncryptedFile} /
	 * {@link createDecryptedObjectUrl}) or fail closed, never render or download
	 * those URLs directly.
	 */
	mediaIsEncrypted: boolean;
	/**
	 * Validated EncryptedFile descriptor for an encrypted attachment
	 * (`m.image` / `m.video` / `m.audio` / `m.file`), used to download + decrypt
	 * it for display / playback / download. Null for plain attachments and
	 * non-attachment events. May ALSO be null when `mediaIsEncrypted === true`
	 * if `content.file` is malformed/incomplete (missing key/iv/hash) —
	 * downstream UI must treat that as a fail-closed "can't decrypt" case, never
	 * rendering the ciphertext.
	 */
	mediaEncryptedFile: EncryptedFileInfo | null;
	/**
	 * True for MSC3245 voice messages (an `m.audio` with the voice
	 * rendering-hint block) - routes to the waveform VoiceMessage renderer
	 * instead of the generic audio player. Parsing lives in
	 * src/lib/voiceMessage.ts.
	 */
	isVoice: boolean;
	/** MSC1767 playback duration in ms; null when not readable. */
	voiceDurationMs: number | null;
	/** MSC3246 waveform normalized to 0..1 floats; null when absent. */
	voiceWaveform: number[] | null;
	isEncrypted: boolean;
	isDecryptionFailure: boolean;
	isEdited: boolean;
	/**
	 * Event ID this message is a reply to, from
	 * `m.relates_to.m.in_reply_to.event_id`. Null when the message isn't a
	 * reply. Drives the quoted reply-context block in `TimelineItem` for all
	 * message types (text, image, media, GIF) — media sends carry only this
	 * relation (no legacy `> ` body prefix), so the context is resolved from
	 * the relation rather than the body.
	 */
	replyToId: string | null;
	/**
	 * Resolved display name of the replied-to event's sender, or its raw
	 * user ID, control-char-guarded. Null when {@link TimelineEvent.replyToId}
	 * is set but the parent event isn't currently resolvable (not in any
	 * loaded timeline) — the renderer then shows a generic "in reply to a
	 * message" affordance instead.
	 */
	replyToSender: string | null;
	/**
	 * One-line snippet of the replied-to event for the quoted context:
	 * the parent's first body line (reply-fallback stripped) for text, or a
	 * short media label (e.g. "📷 Image") for attachments. Truncated and
	 * control-char-stripped. Null when the parent isn't resolvable.
	 */
	replyToBody: string | null;
	/**
	 * Thumbnail http URL of the replied-to event's media, shown as a tiny
	 * preview in the quoted reply-context block so the reply visually identifies
	 * *which* image it answers. Populated only when the parent is an `m.image`
	 * or `m.sticker`; null otherwise (text/video/audio/file keep just the
	 * {@link TimelineEvent.replyToBody} label). Scaled server-side for plain
	 * media. For an *encrypted* parent this is the *unscaled ciphertext* URL
	 * (server-side thumbnailing can't apply to opaque ciphertext) — the renderer
	 * must download + decrypt it via {@link TimelineEvent.replyToThumbEncryptedFile},
	 * downscale via CSS, and fail closed, never rendering the ciphertext as an
	 * `<img>`.
	 */
	replyToThumbUrl: string | null;
	/**
	 * Parsed `content.file` of an encrypted replied-to image/sticker, used to
	 * decrypt {@link TimelineEvent.replyToThumbUrl}. Null for plain parents and
	 * when the encrypted descriptor is malformed (fail closed — no thumbnail).
	 */
	replyToThumbEncryptedFile: EncryptedFileInfo | null;
	/**
	 * Plaintext mimetype (`info.mimetype`) used to decrypt
	 * {@link TimelineEvent.replyToThumbEncryptedFile}. Only set for *encrypted*
	 * image/sticker parents; null for plain parents (whose `replyToThumbUrl` is
	 * shown directly, no mimetype needed) and all non-image parents.
	 */
	replyToThumbMimetype: string | null;
	reactions: Record<string, ReactionAggregate>;
	myReactions: Record<string, string>;
	/**
	 * SDK send status for this event:
	 * - null: server-confirmed (the normal case for received events).
	 * - SENDING / QUEUED / ENCRYPTING: local echo in flight.
	 * - NOT_SENT: send failed, awaiting retry or discard.
	 * - CANCELLED: cancelled by user; usually removed from the store
	 *   before render but kept here for completeness.
	 */
	status: EventStatus | null;
	/**
	 * Derived, pre-rendered text for non-message state events
	 * (m.room.member joins/leaves/profile changes, room.name / topic /
	 * avatar / encryption / canonical_alias / tombstone). Null for
	 * regular messages. When non-null, `TimelineItem` renders a
	 * compact one-line notice instead of the standard message bubble
	 * and skips avatars, headers, hover toolbars, reactions, and
	 * read-receipt rows.
	 */
	stateNotice: StateNotice | null;
	/**
	 * Structured membership-transition metadata for `m.room.member` events
	 * that the timeline can collapse into a grouped notice (join / leave /
	 * invite / kick / ban). Null for non-member events and for member events
	 * that should stay individual (profile-only change, invite
	 * withdrawal/rejection, unban). When set, `stateNotice` is also set.
	 */
	membershipTransition: MembershipTransition | null;
	/**
	 * Fully-projected poll view model for `m.poll.start` events (stable or
	 * unstable prefix), null for everything else. Like the reaction fields,
	 * this is relation-derived data folded into the target row at projection
	 * time: the poll watcher recomputes the snapshot as vote/end relations
	 * arrive and re-projects this row. Poll response and end events
	 * themselves are never displayable.
	 */
	poll: PollSnapshot | null;
	/**
	 * Thread summary when this event heads a thread ("N replies" chip),
	 * null otherwise. Like `poll`, relation-derived data folded into the
	 * root's row at projection time: the thread watcher recomputes the
	 * summary as replies arrive and re-projects this row. The replies
	 * themselves are never displayable here (they live in the thread's
	 * own timeline).
	 */
	thread: ThreadSummary | null;
}

// Reject any ASCII control character (C0 range 0x00–0x1F, plus DEL 0x7F).
// Used to guard user-controlled strings that flow into UI labels (filenames,
// the lightbox header, download attributes, etc.) so a CR/LF/NUL/etc. can't
// corrupt rendering or downstream consumers.
// ASCII control character (C0 range 0x00–0x1F, plus DEL 0x7F) — the single
// boundary both `hasControlChar` (reject) and `stripControlChars` (sanitize)
// key off, so the policy can't drift between them.
function isControlCharCode(c: number): boolean {
	return c < 0x20 || c === 0x7f;
}

function hasControlChar(s: string): boolean {
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
function sanitizeMultiline(s: string): string {
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
function buildReplySnippet(parent: MatrixEvent): string {
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

function syntheticCallLeaveId(leave: SyntheticCallLeave): string {
	// userId (always) and deviceId (possibly) contain `:`, so encode each
	// variable segment to keep the key collision-free for Solid's reconcile.
	return `${SYNTHETIC_CALL_LEAVE_PREFIX}${encodeURIComponent(leave.userId)}:${encodeURIComponent(leave.deviceId)}:${leave.expiresAt}`;
}

function isSyntheticEventId(eventId: string): boolean {
	return eventId.startsWith(SYNTHETIC_CALL_LEAVE_PREFIX);
}

/**
 * Trim the oldest rows from the live-append store until the number of real
 * (non-synthetic) rows is within `limit`. Synthetic expiry-leave rows are not
 * part of the `TimelineWindow` and so don't count toward its limit, but any
 * that fall within the trimmed leading run are removed too.
 */
function capStoreToRealLimit(draft: TimelineEvent[], limit: number): void {
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

/**
 * Build a displayable `TimelineEvent` for a synthesized expiry-based
 * "left the call" notice. Resolves the subject name and avatar from current
 * room state (call-member events carry no profile data), mirroring
 * `callMemberNotice` / `callMemberAvatarUrl` in `stateNotice.ts`. All
 * media/reaction/edit fields are neutral defaults — this row only ever renders
 * as a grouped membership notice.
 */
function buildSyntheticCallLeaveEvent(
	leave: SyntheticCallLeave,
	room: Room,
	client: MatrixClient,
): TimelineEvent {
	const member = room.getMember(leave.userId);
	const subject = member?.name?.trim() || leave.userId;
	const mxc = member?.getMxcAvatarUrl?.() ?? "";
	const avatarUrl = mxc
		? (client.mxcUrlToHttp(mxc, 48, 48, "crop") ?? null)
		: null;
	return {
		eventId: syntheticCallLeaveId(leave),
		senderId: leave.userId,
		senderName: subject,
		timestamp: leave.expiresAt,
		type: CALL_MEMBER_EVENT_TYPE,
		msgtype: "",
		body: "",
		format: null,
		formattedBody: null,
		mediaUrl: null,
		mediaWidth: null,
		mediaHeight: null,
		mediaFullUrl: null,
		mediaPosterUrl: null,
		mediaMimetype: null,
		mediaSize: null,
		mediaFilename: null,
		mediaCaption: null,
		mediaThumbnailUrl: null,
		mediaThumbnailFile: null,
		mediaThumbnailMimetype: null,
		mediaIsEncrypted: false,
		mediaEncryptedFile: null,
		isVoice: false,
		voiceDurationMs: null,
		voiceWaveform: null,
		isEncrypted: false,
		isDecryptionFailure: false,
		isEdited: false,
		replyToId: null,
		replyToSender: null,
		replyToBody: null,
		replyToThumbUrl: null,
		replyToThumbEncryptedFile: null,
		replyToThumbMimetype: null,
		// Null-prototype maps for consistency with eventToTimelineEvent and to
		// keep reaction-key lookups safe from prototype-pollution edge cases.
		reactions: Object.create(null) as TimelineEvent["reactions"],
		myReactions: Object.create(null) as TimelineEvent["myReactions"],
		status: null,
		stateNotice: { text: `${subject} left the call`, icon: "leave" },
		membershipTransition: {
			kind: "call_leave",
			userId: leave.userId,
			subject,
			avatarUrl,
		},
		poll: null,
		thread: null,
	};
}

function eventToTimelineEvent(
	event: MatrixEvent,
	room: Room,
	client: MatrixClient,
	suppressedCallIds?: ReadonlySet<string>,
	pollWatcher?: PollWatcher,
	threadWatcher?: ThreadWatcher,
	// Reactions on thread events live on the THREAD's relations set, so a
	// thread-scoped projection passes the thread's timeline set here.
	relationsTimelineSet?: EventTimelineSet,
): TimelineEvent {
	// `event.getContent()` auto-applies a replacing event's
	// `m.new_content` regardless of the replacement's status. For
	// FAILED (NOT_SENT) or CANCELLED edit echoes, fall back to the
	// original content so the failed edit doesn't silently overwrite
	// the body. SENDING / QUEUED / ENCRYPTING in-flight edits stay
	// optimistic and apply immediately.
	const replacementId = event.replacingEventId();
	const replacement =
		replacementId && typeof event.replacingEvent === "function"
			? event.replacingEvent()
			: null;
	const replacementFailed =
		!!replacement &&
		(replacement.status === EventStatus.NOT_SENT ||
			replacement.status === EventStatus.CANCELLED);
	const content = replacementFailed
		? // Stripped test doubles may not implement getOriginalContent;
			// fall back gracefully.
			typeof event.getOriginalContent === "function"
			? event.getOriginalContent()
			: event.getContent()
		: event.getContent();
	const sender = event.getSender() ?? "";
	const member = room.getMember(sender);

	let mediaUrl: string | null = null;
	let mediaFullUrl: string | null = null;
	const encryptedMxc =
		typeof content.file?.url === "string" && content.file.url.length > 0
			? content.file.url
			: null;
	const plainMxc =
		typeof content.url === "string" && content.url.length > 0
			? content.url
			: null;
	const mxcUrl = plainMxc || encryptedMxc;
	const mediaIsEncrypted = !plainMxc && encryptedMxc !== null;
	if (mxcUrl) {
		mediaUrl = client.mxcUrlToHttp(mxcUrl, 800, 600, "scale") ?? null;
		mediaFullUrl = client.mxcUrlToHttp(mxcUrl) ?? null;
	}

	// Media metadata (mimetype / size / filename / encrypted descriptor),
	// populated for every event that renders from a media source: the attachment
	// msgtypes (so the file/video/audio renderers and the image lightbox can read
	// it) plus `m.sticker` (which renders as an image and may be encrypted — it
	// must fail closed / decrypt rather than render its ciphertext URL). GIF-URL
	// `m.text` rows aren't media sources in this sense, so they don't get these
	// fields.
	const isAttachment =
		content.msgtype === "m.image" ||
		content.msgtype === "m.video" ||
		content.msgtype === "m.audio" ||
		content.msgtype === "m.file";
	const hasMediaSource = isAttachment || event.getType() === "m.sticker";
	const infoMime =
		hasMediaSource && typeof content.info?.mimetype === "string"
			? content.info.mimetype
			: null;
	const infoSize =
		hasMediaSource &&
		typeof content.info?.size === "number" &&
		Number.isFinite(content.info.size) &&
		content.info.size >= 0
			? content.info.size
			: null;
	// Prefer `content.filename` only when it's a non-empty, non-whitespace
	// string — an empty/whitespace `filename` would otherwise block the
	// fallback to `content.body` even though the latter may carry a
	// usable filename.
	const rawFilename =
		hasMediaSource &&
		typeof content.filename === "string" &&
		content.filename.trim().length > 0
			? content.filename
			: hasMediaSource && typeof content.body === "string"
				? content.body
				: null;
	// Treat whitespace-only, multi-line, or otherwise control-char-bearing
	// bodies as "no filename" — attachment events often carry a caption-style
	// body that isn't actually a filename, and any ASCII control char
	// (LF, CR, NUL, DEL, etc.) would corrupt UI labels / the lightbox header
	// if used directly.
	const trimmedFilename = rawFilename?.trim();
	const mediaFilename =
		trimmedFilename && !hasControlChar(trimmedFilename)
			? trimmedFilename
			: null;

	// Plain video poster from the cleartext `info.thumbnail_url`. Encrypted
	// videos carry a ciphertext `thumbnail_file` instead, decoded separately
	// into the `mediaThumbnail*` fields below — never from this cleartext URL.
	const mediaPosterUrl =
		content.msgtype === "m.video" &&
		!mediaIsEncrypted &&
		typeof content.info?.thumbnail_url === "string" &&
		content.info.thumbnail_url.length > 0
			? (client.mxcUrlToHttp(content.info.thumbnail_url, 800, 600, "scale") ??
				null)
			: null;

	// Encrypted-video poster source: the ciphertext `info.thumbnail_file`
	// (an EncryptedFile block, like `content.file`). Parsed + resolved here so
	// the renderer can download + decrypt it for a real poster before play.
	// Best-effort: a malformed descriptor leaves these null and the renderer
	// just shows no poster — it never blocks playback or renders ciphertext.
	const mediaThumbnailFile =
		content.msgtype === "m.video" && mediaIsEncrypted
			? parseEncryptedFile(content.info?.thumbnail_file)
			: null;
	const mediaThumbnailUrl = mediaThumbnailFile
		? (client.mxcUrlToHttp(mediaThumbnailFile.url) ?? null)
		: null;
	const mediaThumbnailMimetype =
		mediaThumbnailFile &&
		typeof content.info?.thumbnail_info?.mimetype === "string"
			? content.info.thumbnail_info.mimetype
			: null;

	// Image caption: spec-correct sends put the filename in `content.filename`
	// and the caption in `content.body`. So a caption exists only when an
	// explicit non-empty `filename` is present AND `body` differs from it (when
	// `filename` is absent, `body` *is* the filename, so there's no caption).
	// Control chars are stripped; multi-line captions are preserved. Scoped to
	// `m.image` — the file/video/audio renderers show the filename as a label.
	const trimmedImageFilename =
		content.msgtype === "m.image" && typeof content.filename === "string"
			? content.filename.trim()
			: "";
	// Consistent with `mediaFilename`'s policy: a control-char-bearing filename
	// (including newlines) isn't a usable explicit filename, so treat it as "no
	// filename" — `body` is then the de-facto filename and there's no caption.
	// This also keeps the filename control-char-free, so comparing it to the
	// sanitized caption below can't mismatch on chars sanitization would erase.
	const hasImageFilename =
		trimmedImageFilename.length > 0 && !hasControlChar(trimmedImageFilename);
	const cleanedCaption =
		typeof content.body === "string"
			? sanitizeMultiline(content.body).trim()
			: "";
	const mediaCaption =
		hasImageFilename &&
		cleanedCaption.length > 0 &&
		cleanedCaption !== trimmedImageFilename
			? cleanedCaption
			: null;

	// Reply context: resolve the parent of an `m.in_reply_to` relation so the
	// renderer can show a quoted snippet for ALL message types (media sends
	// carry only this relation, no legacy `> ` body prefix). When the parent
	// isn't in any loaded timeline, keep the id but leave sender/body null so
	// the renderer shows a generic affordance.
	//
	// MSC3440: a thread reply carries an m.in_reply_to FALLBACK pointer at
	// the previous thread message (for thread-unaware clients), flagged
	// is_falling_back: true. That must not render as a quote; a REAL
	// in-thread reply omits the flag or sets it false and keeps its quote
	// (Element suppresses only on a truthy flag).
	const relatesTo = content["m.relates_to"];
	const isThreadFallbackReply =
		relatesTo?.rel_type === "m.thread" && relatesTo.is_falling_back === true;
	const inReplyToRaw = isThreadFallbackReply
		? undefined
		: relatesTo?.["m.in_reply_to"]?.event_id;
	const replyToId =
		typeof inReplyToRaw === "string" && inReplyToRaw.length > 0
			? inReplyToRaw
			: null;
	let replyToSender: string | null = null;
	let replyToBody: string | null = null;
	let replyToThumbUrl: string | null = null;
	let replyToThumbEncryptedFile: EncryptedFileInfo | null = null;
	let replyToThumbMimetype: string | null = null;
	if (replyToId) {
		const parent = room.findEventById(replyToId);
		if (parent) {
			const parentSender = parent.getSender() ?? "";
			const rawName = room.getMember(parentSender)?.name?.trim();
			replyToSender =
				rawName && !hasControlChar(rawName) ? rawName : parentSender || null;
			replyToBody = buildReplySnippet(parent) || null;

			// Thumbnail preview for image/sticker parents so the reply visually
			// identifies which media it answers. Same plain-vs-encrypted mxc
			// derivation as the main media projection below; everything else
			// (text/video/audio/file) keeps just the text label. Fail closed:
			// an encrypted parent with a malformed `content.file` leaves the
			// thumb url null so we never render ciphertext.
			const parentContent = parent.getContent();
			const isImageish =
				parent.getType() === "m.sticker" || parentContent.msgtype === "m.image";
			if (isImageish) {
				const parentPlainMxc =
					typeof parentContent.url === "string" && parentContent.url.length > 0
						? parentContent.url
						: null;
				const parentEncryptedMxc =
					typeof parentContent.file?.url === "string" &&
					parentContent.file.url.length > 0
						? parentContent.file.url
						: null;
				if (parentPlainMxc) {
					replyToThumbUrl =
						client.mxcUrlToHttp(parentPlainMxc, 96, 96, "scale") ?? null;
				} else if (parentEncryptedMxc) {
					const encryptedFile = parseEncryptedFile(parentContent.file);
					if (encryptedFile) {
						// Encrypted media can't use server-side thumbnailing (the
						// ciphertext is opaque); resolve the full ciphertext url and
						// let the renderer decrypt + downscale via CSS.
						replyToThumbUrl = client.mxcUrlToHttp(parentEncryptedMxc) ?? null;
						replyToThumbEncryptedFile = encryptedFile;
						replyToThumbMimetype =
							typeof parentContent.info?.mimetype === "string"
								? parentContent.info.mimetype
								: null;
					}
				}
			}
		}
	}

	// Intrinsic dimensions, used by `TimelineItem` to reserve the layout box
	// before the media decodes. Gated on msgtype / type so events with an
	// `info` block but no visual box (e.g. an m.file that happens to carry a
	// `w`/`h`) don't produce misleading non-null values. Covers image / sticker
	// / video, plus m.text messages whose entire body is a recognized GIF
	// provider URL (our Composer attaches `info.w/h` to those so the GIF row
	// can reserve its box exactly like m.image does).
	const bodyForGifCheck = typeof content.body === "string" ? content.body : "";
	const isGifText =
		content.msgtype === "m.text" && extractGifUrl(bodyForGifCheck) !== null;
	const hasIntrinsicBox =
		content.msgtype === "m.image" ||
		content.msgtype === "m.video" ||
		event.getType() === "m.sticker" ||
		isGifText;
	const rawW = hasIntrinsicBox ? content.info?.w : undefined;
	const rawH = hasIntrinsicBox ? content.info?.h : undefined;
	const validW = typeof rawW === "number" && Number.isFinite(rawW) && rawW > 0;
	const validH = typeof rawH === "number" && Number.isFinite(rawH) && rawH > 0;
	// All-or-nothing: a single dimension can't reserve a usable
	// aspect-ratio box, so only expose dims when both are valid.
	const mediaWidth = validW && validH ? rawW : null;
	const mediaHeight = validW && validH ? rawH : null;

	// Aggregate reactions from SDK relations. Exclude failed (NOT_SENT)
	// and cancelled relations so a failed local-echo reaction does not
	// keep inflating the count or the user's pressed-state map. The SDK
	// only auto-removes CANCELLED from relations, not NOT_SENT.
	const reactions = Object.create(null) as TimelineEvent["reactions"];
	const myReactions = Object.create(null) as TimelineEvent["myReactions"];
	const myUserId = client.getUserId();
	try {
		const eventId = event.getId();
		if (eventId) {
			const relationsGroup = (
				relationsTimelineSet ?? room.getUnfilteredTimelineSet()
			).relations?.getChildEventsForEvent(
				eventId,
				"m.annotation",
				"m.reaction",
			);
			if (relationsGroup) {
				const sortedEntries = relationsGroup.getSortedAnnotationsByKey();
				if (sortedEntries) {
					for (const [key, evSet] of sortedEntries) {
						if (key && evSet) {
							const senders: ReactionAggregate["senders"] = [];
							const seenSenders = new Set<string>();
							// Track the best candidate id for myUserId across same-key
							// echoes. Prefer server-confirmed (status === null) over
							// pending, breaking ties by ts so the redaction path always
							// targets the freshest valid event regardless of Set
							// iteration order (matrix-js-sdk does not guarantee local
							// echo comes before its server-confirmed counterpart).
							let myBestId: string | undefined;
							let myBestPending = true;
							let myBestTs = Number.NEGATIVE_INFINITY;
							for (const ev of evSet) {
								const evStatus = ev.status;
								if (
									evStatus === EventStatus.NOT_SENT ||
									evStatus === EventStatus.CANCELLED
								) {
									continue;
								}
								const senderId = ev.getSender();
								if (!senderId) continue;
								if (myUserId && senderId === myUserId) {
									const id = ev.getId();
									if (id) {
										const isPending = evStatus !== null;
										const ts = ev.getTs();
										const better =
											myBestId === undefined ||
											(myBestPending && !isPending) ||
											(myBestPending === isPending && ts > myBestTs);
										if (better) {
											myBestId = id;
											myBestPending = isPending;
											myBestTs = ts;
										}
									}
								}
								if (seenSenders.has(senderId)) continue;
								seenSenders.add(senderId);
								const rawName = room.getMember(senderId)?.name?.trim();
								const name =
									rawName && !hasControlChar(rawName) ? rawName : senderId;
								senders.push({ userId: senderId, name });
							}
							if (myBestId) myReactions[key] = myBestId;
							if (senders.length > 0) {
								// Sort by display name (locale-aware, case-insensitive)
								// with userId as a stable tiebreaker so the tooltip and
								// aria-label render in a deterministic order regardless
								// of relation Set iteration order.
								senders.sort((a, b) => {
									const cmp = a.name.localeCompare(b.name, undefined, {
										sensitivity: "base",
									});
									return cmp !== 0 ? cmp : a.userId.localeCompare(b.userId);
								});
								reactions[key] = { count: senders.length, senders };
							}
						}
					}
				}
			}
		}
	} catch {
		// Relations API may not be available for all events
	}

	// `isEdited` reflects whether an edit is in effect on the rendered
	// body. Mirrors the content selection above: failed/cancelled
	// replacements aren't applied, so they don't count as edited.
	// Server-confirmed and in-flight (SENDING / QUEUED / ENCRYPTING)
	// replacements do.
	const isEdited = !!replacementId && !replacementFailed;

	// Pre-compute the one-line notice for state events (joins, name
	// changes, etc.). Null for regular messages and for state events
	// that carry no user-visible change (e.g. join->join with the
	// same display name and avatar). A call-member event reconciled
	// away as a per-device duplicate / premature leave is treated like
	// a no-op transition so it never renders a notice (see #215).
	const isSuppressedCall =
		event.getType() === CALL_MEMBER_EVENT_TYPE &&
		(suppressedCallIds?.has(event.getId() ?? "") ?? false);
	const stateNotice =
		!isSuppressedCall && isStateNoticeType(event.getType())
			? buildStateNotice(event, room)
			: null;
	const membershipTransition =
		stateNotice !== null &&
		(event.getType() === "m.room.member" ||
			event.getType() === CALL_MEMBER_EVENT_TYPE)
			? buildMembershipTransition(event, room, client)
			: null;

	// Poll snapshot: relation-derived (votes / end) like reactions, but
	// resolved through the poll watcher's synchronous cache since the SDK
	// Poll model only exposes responses asynchronously. The watcher
	// re-projects this row as responses stream in.
	const poll = M_POLL_START.matches(event.getType())
		? (pollWatcher?.getSnapshot(event, room) ?? null)
		: null;

	// MSC3245 voice message: parse-and-validate lives in lib/voiceMessage.
	const isVoice = isVoiceMessageContent(content);
	const voiceInfo = isVoice ? parseVoiceInfo(content) : null;

	// Thread summary for roots: resolved through the thread watcher's
	// synchronous cache (live Thread object, or the root's bundled
	// aggregation for paginated-in roots). Null for everything that heads
	// no thread. A plain message that later becomes a root re-projects
	// live via the watcher's ThreadEvent subscription.
	const thread = threadWatcher?.getSummary(event, room) ?? null;

	return {
		eventId: event.getId() ?? "",
		senderId: sender,
		senderName: member?.name ?? sender,
		timestamp: event.getTs(),
		type: event.getType(),
		msgtype: typeof content.msgtype === "string" ? content.msgtype : "",
		body: typeof content.body === "string" ? content.body : "",
		format: typeof content.format === "string" ? content.format : null,
		formattedBody:
			typeof content.formatted_body === "string"
				? content.formatted_body
				: null,
		mediaUrl,
		mediaWidth,
		mediaHeight,
		mediaFullUrl: hasMediaSource ? mediaFullUrl : null,
		mediaPosterUrl,
		mediaMimetype: infoMime,
		mediaSize: infoSize,
		mediaFilename,
		mediaCaption,
		mediaThumbnailUrl,
		mediaThumbnailFile,
		mediaThumbnailMimetype,
		mediaIsEncrypted: hasMediaSource && mediaIsEncrypted,
		mediaEncryptedFile:
			hasMediaSource && mediaIsEncrypted
				? parseEncryptedFile(content.file)
				: null,
		isVoice,
		voiceDurationMs: voiceInfo?.durationMs ?? null,
		voiceWaveform: voiceInfo?.waveform ?? null,
		isEncrypted: event.isEncrypted(),
		isDecryptionFailure: event.isEncrypted() && event.isDecryptionFailure(),
		isEdited,
		replyToId,
		replyToSender,
		replyToBody,
		replyToThumbUrl,
		replyToThumbEncryptedFile,
		replyToThumbMimetype,
		reactions,
		myReactions,
		status: event.status ?? null,
		stateNotice,
		membershipTransition,
		poll,
		thread,
	};
}

function isDisplayable(
	event: MatrixEvent,
	room: Room,
	suppressedCallIds?: ReadonlySet<string>,
	// A thread-scoped window (the thread panel) DOES display thread
	// replies - they are its content.
	displayThreadReplies = false,
): boolean {
	const type = event.getType();
	const isStateNotice = isStateNoticeType(type);
	// Poll *start* events render as timeline rows. Poll responses and ends
	// (`m.poll.response` / `m.poll.end`) are reference relations consumed by
	// the SDK Poll model and stay excluded by this whitelist, mirroring how
	// reactions and edits fold into their target row.
	const isPollStart = M_POLL_START.matches(type);
	if (
		type !== "m.room.message" &&
		type !== "m.room.encrypted" &&
		type !== "m.sticker" &&
		!isPollStart &&
		!isStateNotice
	) {
		return false;
	}
	// Filter out message edits (m.replace) — they update existing events
	const relType = event.getContent()?.["m.relates_to"]?.rel_type;
	if (relType === "m.replace") return false;
	// Thread replies live in their thread's timeline, not the room's. The
	// SDK already partitions them out of room timeline sets; this backstop
	// catches strays (thread ROOTS pass - isThreadReply excludes them).
	if (!displayThreadReplies && isThreadReply(event)) return false;
	// State notices are displayable only when they produce a non-null
	// notice (filters out no-op transitions like join->join with no
	// profile change). This keeps the invariant that every displayable
	// state event has a renderable text.
	if (isStateNotice) {
		// A call-member event reconciled away as a per-device duplicate /
		// premature leave carries no notice, so it isn't displayable (#215).
		if (
			type === CALL_MEMBER_EVENT_TYPE &&
			(suppressedCallIds?.has(event.getId() ?? "") ?? false)
		) {
			return false;
		}
		return buildStateNotice(event, room) !== null;
	}
	// Locally-redacted-pending events: matrix-js-sdk's `markLocallyRedacted`
	// sets `unsigned.redacted_because` so `isRedacted()` is already true
	// and `getContent()` / `getOriginalContent()` both return `{}` the
	// moment the user clicks Delete. Detect via the presence of the
	// pending redaction reference and keep the event displayable so the
	// "Deleting…" / "Delete failed" overlay has somewhere to render.
	// Once the server confirms, `makeRedacted` clears
	// `_localRedactionEvent` and this branch stops matching, so the
	// next msgtype check below filters the event out as normal.
	const hasLocalRedaction =
		typeof event.localRedactionEvent === "function" &&
		!!event.localRedactionEvent();
	if (hasLocalRedaction) return true;
	// Filter out redacted events (content cleared by server)
	if (type === "m.room.message" && !event.getContent()?.msgtype) return false;
	// A poll start must yield a parseable definition (question + answers) to
	// have anything to render; redacted or malformed ones are filtered out.
	if (isPollStart) return parsePollStart(event) !== null;
	return true;
}

const WINDOW_LIMIT = 2000;
const INITIAL_WINDOW_SIZE = 500;

export interface UseTimelineOptions {
	windowLimit?: number;
	initialWindowSize?: number;
	/**
	 * Which timeline to window over: the room's main timeline (default)
	 * or one thread's timeline (the thread panel). Reactive - a key
	 * change reloads the window. See {@link TimelineSource}.
	 */
	source?: () => TimelineSource;
}

/** Module-level default so the source identity is stable across renders. */
const MAIN_SOURCE = mainTimelineSource();

export function useTimeline(
	client: MatrixClient,
	roomId: () => string,
	opts?: UseTimelineOptions,
) {
	const rawLimit = opts?.windowLimit;
	const windowLimit =
		rawLimit != null && Number.isFinite(rawLimit) && rawLimit >= 1
			? Math.floor(rawLimit)
			: WINDOW_LIMIT;
	const rawInitSize = opts?.initialWindowSize;
	const initialWindowSize =
		rawInitSize != null && Number.isFinite(rawInitSize) && rawInitSize >= 1
			? Math.min(Math.floor(rawInitSize), windowLimit)
			: Math.min(INITIAL_WINDOW_SIZE, windowLimit);
	const source = (): TimelineSource => opts?.source?.() ?? MAIN_SOURCE;

	/** isDisplayable bound to this hook's source: a thread window displays
	 *  thread replies, the main window excludes them. */
	function isRowDisplayable(
		event: MatrixEvent,
		room: Room,
		suppressedCallIds?: ReadonlySet<string>,
	): boolean {
		return isDisplayable(event, room, suppressedCallIds, source().inThread);
	}
	const [events, setEvents] = createStore<TimelineEvent[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [loadingOlder, setLoadingOlder] = createSignal(false);
	const [loadingNewer, setLoadingNewer] = createSignal(false);
	const [canLoadOlder, setCanLoadOlder] = createSignal(true);
	const [canLoadNewer, setCanLoadNewer] = createSignal(false);
	const [typingUsers, setTypingUsers] = createSignal<
		{ userId: string; displayName: string }[]
	>([]);

	/**
	 * Pending-redaction status keyed by *target* event ID. Surfaces a
	 * "Deleting…" overlay on the target while the redaction round-trips,
	 * and a "Delete failed — Retry / Discard" affordance when the
	 * redaction echo transitions to NOT_SENT. Cleared when the
	 * redaction confirms (the SDK's confirm path also removes the
	 * target from `events`) or is cancelled.
	 *
	 * The redaction `MatrixEvent` reference is stored directly so
	 * Retry/Discard work even when the user has scrolled away from
	 * live; the SDK's TimelineWindow may not include the redaction
	 * echo (it lives at the live end) once `followingLive` is false.
	 */
	interface PendingRedaction {
		redactionEvent: MatrixEvent;
		status: EventStatus;
	}
	const [pendingRedactions, setPendingRedactions] = createStore<
		Record<string, PendingRedaction>
	>({});

	function recordPendingRedaction(redactionEvent: MatrixEvent): void {
		const targetId = redactionEvent.event.redacts;
		const status = redactionEvent.status;
		if (typeof targetId !== "string" || !status) return;
		setPendingRedactions(targetId, { redactionEvent, status });
	}

	function clearPendingRedaction(targetId: string): void {
		setPendingRedactions(
			produce((d) => {
				delete d[targetId];
			}),
		);
	}

	/**
	 * Failed reaction echoes keyed by target event ID, then by reaction
	 * key (unicode emoji or `mxc://` URL for custom emotes). Each entry
	 * is the array of failed `MatrixEvent`s — multiple clicks during an
	 * outage can stack failures for the same key.
	 *
	 * Lifecycle (per-event-ID): NOT_SENT upserts; SENDING / QUEUED /
	 * ENCRYPTING (retry in-flight) removes; null (confirmed) / CANCELLED
	 * removes. Empty inner records are pruned, then empty outer keys.
	 *
	 * Stores `MatrixEvent` directly so Retry / Discard work even when
	 * the user has scrolled away from live; the SDK's TimelineWindow
	 * may not include the failed reaction echo once `followingLive` is
	 * false.
	 */
	const [pendingReactions, setPendingReactions] = createStore<
		Record<string, Record<string, MatrixEvent[]>>
	>(Object.create(null));

	/**
	 * Failed edit (m.replace) echoes keyed by target event ID. Same
	 * stacking semantics as `pendingReactions`: each entry is an array
	 * of failed `MatrixEvent`s so repeated retries during an outage
	 * remain discoverable / discardable. Retry uses the most-recent
	 * entry; Discard cancels all.
	 */
	const [pendingEdits, setPendingEdits] = createStore<
		Record<string, MatrixEvent[]>
	>(Object.create(null));

	function upsertPendingReaction(reactionEvent: MatrixEvent): void {
		const content = reactionEvent.getContent();
		const targetId = content?.["m.relates_to"]?.event_id;
		const key = content?.["m.relates_to"]?.key;
		const eid = reactionEvent.getId();
		if (typeof targetId !== "string" || typeof key !== "string" || !eid) {
			return;
		}
		setPendingReactions(
			produce((d) => {
				let byKey = d[targetId];
				if (!byKey) {
					byKey = Object.create(null);
					d[targetId] = byKey;
				}
				let arr = byKey[key];
				if (!arr) {
					arr = [];
					byKey[key] = arr;
				}
				if (!arr.some((e) => e.getId() === eid)) {
					arr.push(reactionEvent);
				}
			}),
		);
	}

	function removePendingReaction(reactionEvent: MatrixEvent): void {
		const content = reactionEvent.getContent();
		const targetId = content?.["m.relates_to"]?.event_id;
		const key = content?.["m.relates_to"]?.key;
		const eid = reactionEvent.getId();
		if (typeof targetId !== "string" || typeof key !== "string" || !eid) {
			return;
		}
		setPendingReactions(
			produce((d) => {
				const byKey = d[targetId];
				if (!byKey) return;
				const arr = byKey[key];
				if (!arr) return;
				const idx = arr.findIndex((e) => e.getId() === eid);
				if (idx >= 0) arr.splice(idx, 1);
				if (arr.length === 0) delete byKey[key];
				if (Object.keys(byKey).length === 0) delete d[targetId];
			}),
		);
	}

	function upsertPendingEdit(editEvent: MatrixEvent): void {
		const targetId = editEvent.getContent()?.["m.relates_to"]?.event_id;
		const eid = editEvent.getId();
		if (typeof targetId !== "string" || !eid) return;
		setPendingEdits(
			produce((d) => {
				let arr = d[targetId];
				if (!arr) {
					arr = [];
					d[targetId] = arr;
				}
				if (!arr.some((e) => e.getId() === eid)) {
					arr.push(editEvent);
				}
			}),
		);
	}

	function removePendingEdit(editEvent: MatrixEvent): void {
		const targetId = editEvent.getContent()?.["m.relates_to"]?.event_id;
		const eid = editEvent.getId();
		if (typeof targetId !== "string" || !eid) return;
		setPendingEdits(
			produce((d) => {
				const arr = d[targetId];
				if (!arr) return;
				const idx = arr.findIndex((e) => e.getId() === eid);
				if (idx >= 0) arr.splice(idx, 1);
				if (arr.length === 0) delete d[targetId];
			}),
		);
	}

	let currentRoomId: string | null = null;
	let currentSourceKey: string | null = null;
	let backfillReloadAttempted = false;
	// Generation counter — increments on every room load. Async operations
	// capture the current generation and bail if it changed (A→B→A safety).
	let roomGeneration = 0;
	let currentTimelineWindow: TimelineWindow | null = null;
	// When true, live events extend the window and push to the store.
	// When false (user scrolled up), live events are withheld and
	// canLoadNewer is set so the UI can offer forward pagination.
	let followingLive = true;
	// Count of live events that arrived during the async gap between
	// loadRoom() setting currentTimelineWindow = null and .then()
	// publishing the new window. On completion, the window extends
	// forward by this count to capture the deferred events.
	let deferredLiveCount = 0;

	// Poll subscriptions + snapshot cache. Poll votes/ends arrive as
	// m.reference relations that no timeline handler displays, so without
	// this seam a poll row would never re-render on a vote. On any poll
	// state change the watcher recomputes the snapshot and re-projects just
	// that poll's row, mirroring the reaction recompute path.
	const pollWatcher = createPollWatcher(client, reprojectRow);
	// Same seam for threads: replies are m.thread relations partitioned out
	// of this timeline entirely, so without the watcher a root's "N replies"
	// chip would never re-render as replies arrive.
	const threadWatcher = createThreadWatcher(reprojectRow);

	/**
	 * Single projection entry point for all call sites in this hook, so
	 * every path (rebuild, live append, redaction/edit/decryption
	 * recomputes) resolves poll snapshots and thread summaries through the
	 * watchers' caches.
	 */
	function projectEvent(
		event: MatrixEvent,
		room: Room,
		suppressedCallIds?: ReadonlySet<string>,
	): TimelineEvent {
		return eventToTimelineEvent(
			event,
			room,
			client,
			suppressedCallIds,
			pollWatcher,
			threadWatcher,
			source().getTimelineSet(room) ?? undefined,
		);
	}

	/** Re-project a single row after its relation-derived data changed (a
	 *  poll vote/end, a thread reply updating the root's summary chip).
	 *  No-op when the event isn't in the current window - the next full
	 *  rebuild picks up the cached snapshot. */
	function reprojectRow(eventId: string): void {
		if (!currentRoomId) return;
		const room = client.getRoom(currentRoomId);
		if (!room) return;
		const sourceEvent = findWindowEvent(eventId);
		if (!sourceEvent) return;
		const updated = projectEvent(sourceEvent, room);
		setEvents(
			produce((draft) => {
				const idx = draft.findIndex((e) => e.eventId === eventId);
				if (idx >= 0) draft[idx] = updated;
			}),
		);
	}

	// Server-clock tracker so expiry-based call-leave synthesis is robust to
	// client clock skew (the homeserver populated `created_ts` / `expires`
	// against its own clock). Seeded from window events on every rebuild and
	// updated from live events; latest sample wins (see `serverTime.ts`).
	const serverTime = createServerTimeTracker();

	// Single pending timer that re-runs `rebuildEventsFromWindow` when the next
	// known MatrixRTC membership expires, so a synthetic "left the call" notice
	// appears the moment the membership lapses (no follow-up event arrives).
	// Guarded by `roomGeneration` so a timer armed before a room switch is
	// ignored when it fires.
	let callExpiryTimer: ReturnType<typeof setTimeout> | null = null;
	// `setTimeout` delays must fit in a signed 32-bit int; clamp defensively.
	const MAX_TIMEOUT_DELAY = 2_147_483_647;
	// Small grace so the timer fires after `now > expiresAt`, not exactly at
	// it, and the re-evaluation reliably sees the membership as expired.
	const CALL_EXPIRY_GRACE_MS = 50;

	function clearCallExpiryTimer(): void {
		if (callExpiryTimer !== null) {
			clearTimeout(callExpiryTimer);
			callExpiryTimer = null;
		}
	}

	function scheduleCallExpiryRefresh(room: Room, nextExpiry: number): void {
		clearCallExpiryTimer();
		const gen = roomGeneration;
		const delay = Math.min(
			Math.max(0, nextExpiry - serverTime.now() + CALL_EXPIRY_GRACE_MS),
			MAX_TIMEOUT_DELAY,
		);
		callExpiryTimer = setTimeout(() => {
			callExpiryTimer = null;
			if (roomGeneration !== gen || currentRoomId !== room.roomId) return;
			rebuildEventsFromWindow(room);
		}, delay);
	}

	/** Find a raw MatrixEvent in the current window by ID */
	function findWindowEvent(eventId: string): MatrixEvent | undefined {
		if (!currentTimelineWindow) return undefined;
		return currentTimelineWindow.getEvents().find((e) => e.getId() === eventId);
	}

	/** Rebuild the displayable events store from the current window */
	function rebuildEventsFromWindow(room: Room): void {
		if (!currentTimelineWindow) return;
		const matrixEvents = currentTimelineWindow.getEvents();
		// Seed/refresh the server-clock offset from the loaded window before
		// computing expiry, so the first paint uses the corrected clock.
		for (const e of matrixEvents) serverTime.sampleFromEvent(e);
		// Per-device call memberships are reconciled into per-user liveness so
		// duplicate joins / premature leaves are hidden, and memberships that
		// lapsed by expiry with no follow-up event get a synthesized
		// "left the call" notice (#215 / #219).
		const now = serverTime.now();
		const { suppressed, syntheticLeaves, nextExpiry } =
			computeCallTimelineNotices(matrixEvents, now);
		const displayable = matrixEvents
			.filter((e) => isRowDisplayable(e, room, suppressed) && e.getId())
			.map((e) => projectEvent(e, room, suppressed));
		// Merge synthetic expiry leaves (sorted ascending by `expiresAt`) into
		// the chronological displayable list. A synthetic leave is placed after
		// any real event sharing its timestamp so an explicit event at the same
		// instant renders first.
		const merged = mergeSyntheticLeaves(displayable, syntheticLeaves, room);
		setEvents(reconcile(merged, { key: "eventId", merge: false }));

		clearCallExpiryTimer();
		if (nextExpiry !== null) scheduleCallExpiryRefresh(room, nextExpiry);
	}

	/**
	 * Merge `synthetic` expiry-leave notices into the already chronological
	 * `displayable` list. Synthetic rows sort after real rows at an equal
	 * timestamp (see {@link mergeRowsByTimestamp}).
	 */
	function mergeSyntheticLeaves(
		displayable: TimelineEvent[],
		synthetic: readonly SyntheticCallLeave[],
		room: Room,
	): TimelineEvent[] {
		if (synthetic.length === 0) return displayable;
		const built = synthetic
			.map((leave) => buildSyntheticCallLeaveEvent(leave, room, client))
			.sort((a, b) => a.timestamp - b.timestamp);
		return mergeRowsByTimestamp(displayable, built);
	}

	/** Remove store events that the window has evicted from its backward end.
	 *  Forward extends evict from the start (chronological order), so we only
	 *  need to trim the store's front until every remaining event is still in
	 *  the window. Only runs when the window is at capacity. */
	function syncStoreEviction(): void {
		if (!currentTimelineWindow) return;
		const windowEvents = currentTimelineWindow.getEvents();
		if (windowEvents.length < windowLimit) return;

		const windowIds = new Set<string>();
		for (const e of windowEvents) {
			const id = e.getId();
			if (id) windowIds.add(id);
		}
		// Oldest timestamp still in the window. A synthetic expiry-leave row has
		// no window id, so it's evicted by its anchor timestamp instead: kept
		// while it's still within the window's time range, trimmed once the
		// window has slid past it.
		const oldestWindowTs = windowEvents[0]?.getTs() ?? Number.NEGATIVE_INFINITY;

		setEvents(
			produce((draft) => {
				// The window holds the most recent slice of the timeline, so the
				// store's evicted rows form a leading region ending at the first
				// real row still in the window. Within that region, drop evicted
				// real rows and synthetic rows anchored before the window; keep
				// synthetic rows still in range. Rows from the boundary onward are
				// all in-window reals or later (in-range) synthetics.
				let boundary = draft.length;
				for (let i = 0; i < draft.length; i++) {
					const id = draft[i].eventId;
					if (!isSyntheticEventId(id) && windowIds.has(id)) {
						boundary = i;
						break;
					}
				}
				for (let i = boundary - 1; i >= 0; i--) {
					const row = draft[i];
					const evicted = isSyntheticEventId(row.eventId)
						? row.timestamp < oldestWindowTs
						: true;
					if (evicted) draft.splice(i, 1);
				}
			}),
		);
	}

	function loadRoom(rid: string): void {
		if (rid !== currentRoomId || source().key !== currentSourceKey) {
			backfillReloadAttempted = false;
			// Clear stale events immediately on room/source switch so the
			// view shows the loading spinner (events.length === 0) instead
			// of the previous timeline's messages under the new header.
			setEvents(reconcile([], { key: "eventId", merge: false }));
		}
		currentRoomId = rid;
		currentSourceKey = source().key;
		roomGeneration++;
		const gen = roomGeneration;
		currentTimelineWindow = null;
		deferredLiveCount = 0;
		followingLive = true;
		// Drop any pending expiry-leave timer from the previous room; the new
		// room re-arms its own from the first rebuild.
		clearCallExpiryTimer();
		setLoading(true);
		setLoadingOlder(false);
		setLoadingNewer(false);
		setCanLoadOlder(false);
		setCanLoadNewer(false);
		setTypingUsers([]);
		setPendingRedactions(reconcile({}, { merge: false }));
		setPendingReactions(reconcile(Object.create(null), { merge: false }));
		setPendingEdits(reconcile(Object.create(null), { merge: false }));

		const room = client.getRoom(rid);
		if (!room) {
			setEvents(reconcile([], { key: "eventId", merge: false }));
			setLoading(false);
			currentTimelineWindow = null;
			return;
		}

		// Re-point the watchers before the first projection so poll rows
		// resolve snapshots (and start their response fetches) and thread
		// roots resolve summaries immediately. No-ops when reloading the
		// same room, keeping fetched state warm.
		pollWatcher.watchRoom(room);
		threadWatcher.watchRoom(room);

		const timelineSet = source().getTimelineSet(room);
		if (!timelineSet) {
			// A thread source whose Thread object doesn't exist (the panel
			// awaits ensureThread before mounting, so this is a stale-open
			// edge): render empty rather than the wrong timeline.
			setEvents(reconcile([], { key: "eventId", merge: false }));
			setLoading(false);
			currentTimelineWindow = null;
			return;
		}
		const tw = new TimelineWindow(client, timelineSet, {
			windowLimit: windowLimit,
		});
		// Defer setting currentTimelineWindow until load completes to
		// prevent live events from calling extend() on an uninitialized
		// window during the async gap.

		tw.load(undefined, initialWindowSize)
			.then(() => {
				if (gen !== roomGeneration) return;

				currentTimelineWindow = tw;

				// Catch up on live events that arrived during the async gap.
				// These events are on the SDK's live timeline but outside the
				// window's range because load() snapshotted before they arrived.
				if (deferredLiveCount > 0) {
					tw.extend(Direction.Forward, deferredLiveCount);
					deferredLiveCount = 0;
				}

				rebuildEventsFromWindow(room);

				// Just-joined / sparse-initial-sync recovery: the SDK's live
				// timeline can contain only non-displayable events (e.g. the
				// user's own `m.room.member` join event after `client.joinRoom()`
				// when the homeserver returns `timeline.limited` with no
				// message events). The window has no displayable content but
				// `canPaginate(Backward)` is true because a `prev_batch` token
				// is set. Without this, the user sees an empty timeline until
				// they manually scroll up or refresh the browser. Auto-backfill
				// a small number of pages so recent history shows up.
				//
				// Keep `loading()` true and skip publishing `canLoadOlder` while
				// the backfill runs so the view doesn't render an empty state
				// and so its scroll-driven auto-pagination doesn't fire
				// concurrently. The non-live `onTimelineEvent` reload path is
				// suppressed by setting `backfillReloadAttempted = true` — the
				// reload it would trigger is exactly what we're doing here.
				if (events.length === 0 && tw.canPaginate(Direction.Backward)) {
					backfillReloadAttempted = true;
					void runInitialBackfill(rid, gen, tw, room);
					return;
				}

				// Set canLoadOlder before loading=false so dependents never
				// observe the transient state (loading=false, canLoadOlder=false,
				// events>0)
				setCanLoadOlder(tw.canPaginate(Direction.Backward));
				setLoadingOlder(false);
				setLoading(false);
			})
			.catch(() => {
				if (gen !== roomGeneration) return;
				setEvents(reconcile([], { key: "eventId", merge: false }));
				setLoading(false);
				setLoadingOlder(false);
			});
	}

	const PAGINATION_SIZE = 50;
	/**
	 * Outer cap on the just-joined / sparse-sync auto-backfill loop.
	 * Each iteration calls `tw.paginate(Direction.Backward, PAGINATION_SIZE, true, 1)`
	 * which bounds the SDK to at most one /messages request per round.
	 * Three rounds is enough to surface real history past a tail of
	 * member/state churn without hammering the server when the room
	 * genuinely has no displayable history past the join point.
	 */
	const INITIAL_BACKFILL_MAX_ROUNDS = 3;
	let paginationRoomId: string | null = null;
	let paginationNewerRoomId: string | null = null;

	/**
	 * Auto-backfill driven by `loadRoom` when the initial window contains
	 * no displayable events but `canPaginate(Backward)` is true. Owns the
	 * `loading` / `canLoadOlder` finalization for that path so the view
	 * stays in its "initial load" visual state until we've either found
	 * displayable history or exhausted the cap.
	 */
	async function runInitialBackfill(
		rid: string,
		gen: number,
		tw: TimelineWindow,
		room: Room,
	): Promise<void> {
		try {
			for (let i = 0; i < INITIAL_BACKFILL_MAX_ROUNDS; i++) {
				if (gen !== roomGeneration) return;
				if (!tw.canPaginate(Direction.Backward)) break;
				// requestLimit=1: cap the SDK's internal /messages recursion
				// per outer round so our INITIAL_BACKFILL_MAX_ROUNDS cap
				// actually bounds the number of network requests.
				await tw.paginate(Direction.Backward, PAGINATION_SIZE, true, 1);
				if (gen !== roomGeneration) return;
				rebuildEventsFromWindow(room);
				if (events.length > 0) break;
			}
		} catch {
			// Best-effort: the user can still scroll up to retry.
		} finally {
			if (gen === roomGeneration && currentRoomId === rid) {
				setCanLoadOlder(tw.canPaginate(Direction.Backward));
				setLoadingOlder(false);
				setLoading(false);
			}
		}
	}

	async function loadOlderMessages(): Promise<void> {
		if (
			loadingOlder() ||
			!canLoadOlder() ||
			!currentRoomId ||
			!currentTimelineWindow
		)
			return;

		const rid = currentRoomId;
		const gen = roomGeneration;
		const tw = currentTimelineWindow;
		const room = client.getRoom(rid);
		if (!room) {
			setCanLoadOlder(false);
			return;
		}

		if (!tw.canPaginate(Direction.Backward)) {
			setCanLoadOlder(false);
			return;
		}

		// Set immediately to prevent concurrent scroll-triggered requests
		setLoadingOlder(true);
		paginationRoomId = rid;

		try {
			await tw.paginate(Direction.Backward, PAGINATION_SIZE);
			// Generation guard — catches A→B→A where roomId matches but
			// this request is from a previous visit
			if (gen !== roomGeneration) return;

			rebuildEventsFromWindow(room);
			setCanLoadOlder(tw.canPaginate(Direction.Backward));
		} catch {
			// Pagination failed — leave current state, user can retry
		} finally {
			// Only clear loading if this is still the active pagination request.
			// Use generation to handle A→B→A where rid matches but request is stale.
			if (paginationRoomId === rid && gen === roomGeneration) {
				setLoadingOlder(false);
				paginationRoomId = null;
			}
		}
	}

	async function loadNewerMessages(): Promise<void> {
		if (
			loadingNewer() ||
			!canLoadNewer() ||
			!currentRoomId ||
			!currentTimelineWindow
		)
			return;

		const rid = currentRoomId;
		const gen = roomGeneration;
		const tw = currentTimelineWindow;
		const room = client.getRoom(rid);
		if (!room) {
			setCanLoadNewer(false);
			return;
		}

		if (!tw.canPaginate(Direction.Forward)) {
			setCanLoadNewer(false);
			// Don't set followingLive here — let the view's
			// [atBottom, canLoadNewer] effect handle the transition
			// when the user actually scrolls to the bottom.
			return;
		}

		setLoadingNewer(true);
		paginationNewerRoomId = rid;

		try {
			await tw.paginate(Direction.Forward, PAGINATION_SIZE);
			if (gen !== roomGeneration) return;

			rebuildEventsFromWindow(room);
			setCanLoadOlder(tw.canPaginate(Direction.Backward));

			if (!tw.canPaginate(Direction.Forward)) {
				setCanLoadNewer(false);
				// Don't set followingLive here — the view drives the
				// transition via the [atBottom, canLoadNewer] effect
				// once the user scrolls to the actual bottom.
			}
		} catch {
			// Forward pagination failed — leave current state, user can retry
		} finally {
			if (paginationNewerRoomId === rid && gen === roomGeneration) {
				setLoadingNewer(false);
				paginationNewerRoomId = null;
			}
		}
	}

	/** Called by the view when the user's scroll position changes.
	 *  When following transitions to true while behind live,
	 *  auto-reloads the window from the live end. */
	function setFollowingLive(following: boolean): void {
		if (following === followingLive) return;
		followingLive = following;
		if (following && canLoadNewer()) {
			jumpToLive();
		}
	}

	/** Reload the window from the live end, discarding the current
	 *  scroll position. Use when the user clicks "Jump to latest". */
	function jumpToLive(): void {
		if (!currentRoomId) return;
		followingLive = true;
		setCanLoadNewer(false);
		setLoadingNewer(false);
		loadRoom(currentRoomId);
	}

	// ID of an event the view layer should scroll to (and flash) once
	// it appears in the events store. Set by `jumpToEvent` and cleared
	// by the consumer after handling. `equals: false` so rapid re-jumps
	// to the same eventId still fire the consumer effect (so the row
	// re-flashes on repeated clicks of the same pinned message).
	const [pendingScrollToId, setPendingScrollToId] = createSignal<string | null>(
		null,
		{ equals: false },
	);

	/** Load a fresh TimelineWindow anchored on `eventId` and signal the
	 *  view to scroll there. Used for the pinned-messages "Jump to"
	 *  action and any other deep-link-style navigation.
	 *
	 *  Lifecycle parallels loadRoom — bumps roomGeneration so in-flight
	 *  paginations bail, switches off followingLive (we're anchored at
	 *  a historical point), and resets deferredLiveCount (live catch-up
	 *  must not apply to an anchored window). After load the view's
	 *  [atBottom, canLoadNewer] effect will re-derive followingLive
	 *  based on whether the anchor happens to be at the live end. */
	async function jumpToEvent(eventId: string): Promise<void> {
		const rid = currentRoomId;
		if (!rid) return;
		const room = client.getRoom(rid);
		if (!room) return;

		// Fast path: event is already in the window. Just nudge the view.
		if (currentTimelineWindow) {
			const existing = currentTimelineWindow
				.getEvents()
				.find((e) => e.getId() === eventId);
			if (existing) {
				// Anchor on the historical row even if it sits inside the
				// current live window. Without this, new live events keep
				// auto-scrolling the view away from the row the user just
				// jumped to. The [atBottom, canLoadNewer] effect will
				// re-enable followingLive if the anchor happens to be at
				// the live end already.
				followingLive = false;
				setPendingScrollToId(eventId);
				return;
			}
		}

		// Resolve the source's set BEFORE bumping the generation: returning
		// after the bump would strand in-flight paginations (their finally
		// blocks see a generation mismatch and never clear loading flags).
		const timelineSet = source().getTimelineSet(room);
		if (!timelineSet) return;
		roomGeneration++;
		const gen = roomGeneration;
		const tw = new TimelineWindow(client, timelineSet, {
			windowLimit: windowLimit,
		});
		currentTimelineWindow = null;
		deferredLiveCount = 0;
		followingLive = false;
		setLoading(true);
		setLoadingOlder(false);
		setLoadingNewer(false);
		setCanLoadOlder(false);
		setCanLoadNewer(false);

		try {
			await tw.load(eventId, initialWindowSize);
			if (gen !== roomGeneration) return;
			currentTimelineWindow = tw;
			rebuildEventsFromWindow(room);
			setCanLoadOlder(tw.canPaginate(Direction.Backward));
			setCanLoadNewer(tw.canPaginate(Direction.Forward));
			setLoading(false);
			setPendingScrollToId(eventId);
		} catch {
			if (gen !== roomGeneration) return;
			// Fall back to a fresh live load so we don't strand the user
			// on a blank timeline.
			setLoading(false);
			loadRoom(rid);
		}
	}

	function consumePendingScrollToId(): void {
		setPendingScrollToId(null);
	}

	function handleRedaction(room: Room, redactedId: string): void {
		// Redacting a call-member event can change per-user liveness (e.g. the
		// only visible join is redacted, so a previously-suppressed sibling
		// device's join should now surface). The incremental path below only
		// touches existing rows and can't restore a hidden sibling, so rebuild
		// the whole window to recompute suppression (#215).
		const redactedSource = findWindowEvent(redactedId);
		if (redactedSource?.getType() === CALL_MEMBER_EVENT_TYPE) {
			rebuildEventsFromWindow(room);
			return;
		}
		setEvents(
			produce((draft) => {
				const idx = draft.findIndex((e) => e.eventId === redactedId);
				if (idx >= 0) {
					const sourceEvent = findWindowEvent(redactedId);
					if (sourceEvent) {
						if (isRowDisplayable(sourceEvent, room)) {
							draft[idx] = projectEvent(sourceEvent, room);
						} else {
							draft.splice(idx, 1);
						}
					} else {
						draft.splice(idx, 1);
					}
				}

				// Build lookup map from window events for O(1) access
				if (!currentTimelineWindow) return;
				const windowEvents = currentTimelineWindow.getEvents();
				const eventMap = new Map<string, MatrixEvent>();
				for (const evt of windowEvents) {
					const id = evt.getId();
					if (id) eventMap.set(id, evt);
				}

				// Recompute reactions for all events (redacted content is
				// already cleared by the SDK, so we can't identify which
				// parent a redacted reaction belonged to)
				for (let i = 0; i < draft.length; i++) {
					const evt = eventMap.get(draft[i].eventId);
					if (evt) {
						draft[i] = projectEvent(evt, room);
					}
				}
			}),
		);
	}

	function handleEdit(room: Room, targetId: string): void {
		// Defer to next microtask so SDK relation aggregation
		// has finished applying the edit to the original event
		queueMicrotask(() => {
			if (room.roomId !== currentRoomId) return;
			const targetEvent = findWindowEvent(targetId);
			if (!targetEvent) return;
			const updated = projectEvent(targetEvent, room);
			setEvents(
				produce((draft) => {
					const idx = draft.findIndex((e) => e.eventId === targetId);
					if (idx >= 0) {
						draft[idx] = updated;
					}
				}),
			);
		});
	}

	function onReplaced(originalEvent: MatrixEvent): void {
		if (!currentRoomId) return;
		const rid = originalEvent.getRoomId();
		if (rid !== currentRoomId) return;
		const room = client.getRoom(rid);
		if (!room) return;
		const eid = originalEvent.getId();
		if (!eid) return;
		setEvents(
			produce((draft) => {
				const idx = draft.findIndex((e) => e.eventId === eid);
				if (idx >= 0) {
					draft[idx] = projectEvent(originalEvent, room);
				}
			}),
		);
	}

	function onTimelineEvent(
		event: MatrixEvent,
		eventRoom: Room | undefined,
		_toStart: boolean | undefined,
		removed: boolean | undefined,
		data: { liveEvent?: boolean; timeline?: EventTimeline },
	): void {
		if (!eventRoom || eventRoom.roomId !== currentRoomId) return;
		// Only emissions belonging to this hook's timeline source may touch
		// its store. Main source: thread timelines re-emit RoomEvent.Timeline
		// through the client, and none of it (replies, or reactions/edits
		// targeting thread events) belongs here. Thread source: only its own
		// thread's emissions do. Gate on both the emitting timeline and the
		// event's own shape - either mismatch skips.
		//
		// Redactions bypass the gate: a redaction of a thread ROOT lives in
		// the MAIN timeline only (eventShouldLiveIn) yet the open panel must
		// tombstone its root row too. handleRedaction keys on the target and
		// no-ops when it isn't in this window, so cross-source redaction
		// traffic is harmless in both directions.
		if (
			event.getType() !== "m.room.redaction" &&
			(!source().acceptsTimeline(data) || !source().acceptsEvent(event))
		)
			return;

		// Removed events (e.g. cancelled local echoes the SDK strips from
		// the timeline before firing LocalEchoUpdated(CANCELLED)) must be
		// dropped from the store. The reaction-aggregation path is handled
		// by the parent's recompute when the relation changes; for direct
		// displayable events, we splice them out by ID.
		if (removed) {
			const eid = event.getId();
			if (!eid) return;
			// Cancelled redaction echo: clear the pending overlay and
			// recompute the target so its body restores. The SDK's
			// `unmarkLocallyRedacted` has already cleared the local
			// redaction state by the time this fires, so
			// `eventToTimelineEvent` will pick up the original content
			// (which `getContent()` now returns again).
			if (event.getType() === "m.room.redaction") {
				const redactedId = event.event.redacts;
				if (typeof redactedId === "string") {
					clearPendingRedaction(redactedId);
					const targetEvent = findWindowEvent(redactedId);
					if (targetEvent) {
						setEvents(
							produce((draft) => {
								const idx = draft.findIndex((e) => e.eventId === redactedId);
								if (idx >= 0 && isRowDisplayable(targetEvent, eventRoom)) {
									draft[idx] = projectEvent(targetEvent, eventRoom);
								}
							}),
						);
					}
				}
			}
			// Defensive cleanup for reaction / edit pending stores. The
			// primary lifecycle path is LocalEchoUpdated(CANCELLED), but
			// the SDK strips events from the timeline before firing it,
			// so the `_removed` path can race ahead in some orderings.
			if (event.getType() === "m.reaction") {
				removePendingReaction(event);
			} else if (
				event.getContent()?.["m.relates_to"]?.rel_type === "m.replace"
			) {
				removePendingEdit(event);
			}
			setEvents(
				produce((draft) => {
					const idx = draft.findIndex((e) => e.eventId === eid);
					if (idx >= 0) draft.splice(idx, 1);
				}),
			);
			return;
		}

		// For non-live events (backfill/initial sync), reload the full
		// timeline so we pick up historical events that weren't available
		// when loadRoom first ran. Only attempt once per room to prevent
		// infinite reload loops when a room has only non-displayable events.
		if (!data.liveEvent) {
			if (events.length === 0 && !backfillReloadAttempted) {
				backfillReloadAttempted = true;
				loadRoom(currentRoomId);
			}
			return;
		}

		// Live event during the async gap between loadRoom() setting
		// currentTimelineWindow = null and .then() publishing the new
		// window. We can't extend or query the window, and anything
		// pushed to the store would be overwritten by rebuildEventsFromWindow.
		// Track the count so .then() can extend to include them.
		// Gate on loading() to avoid permanently withholding events after
		// a failed load (where window stays null but no .then() will run).
		if (!currentTimelineWindow) {
			if (loading()) {
				deferredLiveCount++;
				return;
			}
			// Window is null outside a load (e.g., after a failed load).
			// Fall through — can't extend, but displayable events can
			// still be pushed to the store in degraded mode.
		}

		const room = client.getRoom(currentRoomId);
		if (!room) return;

		// Keep the server-clock offset fresh from live traffic so call-leave
		// expiry math (below / on the rebuild timer) tracks the homeserver.
		const offsetBefore = serverTime.getOffsetMs();
		serverTime.sampleFromEvent(event);
		const offsetChangedMaterially =
			Math.abs(serverTime.getOffsetMs() - offsetBefore) >=
			MATERIAL_OFFSET_CHANGE_MS;

		// Only extend the window when following live. When the user has
		// scrolled up, withhold new events to keep the window stable and
		// prevent eviction of events the user is viewing.
		if (followingLive && currentTimelineWindow) {
			currentTimelineWindow.extend(Direction.Forward, 1);
			syncStoreEviction();
		} else if (!followingLive) {
			// Track that the window is behind live for ANY skipped event
			// (displayable, reaction, edit, state), not just displayable ones.
			setCanLoadNewer(true);
		}

		// A material server-clock correction (e.g. the loaded window lacked
		// `unsigned.age` so the offset was 0, and this live event finally
		// supplies it) invalidates the already-armed expiry timer's delay and
		// can flip whether a membership reads as expired. Rebuild from the
		// (now-extended) window so synthetic leaves and the timer are recomputed
		// against the corrected clock; this also displays the just-arrived event.
		if (offsetChangedMaterially && followingLive && currentTimelineWindow) {
			rebuildEventsFromWindow(room);
			return;
		}

		// Handle reaction events by updating the target message's reactions
		if (event.getType() === "m.reaction") {
			// Track failed echoes for the Retry/Discard UI. Confirmed
			// reactions flow through the relation aggregation only;
			// other transient statuses (SENDING, QUEUED, ENCRYPTING) are
			// not surfaced as failures.
			if (event.status === EventStatus.NOT_SENT) {
				upsertPendingReaction(event);
			}
			const relatesTo = event.getContent()?.["m.relates_to"];
			if (relatesTo?.event_id) {
				const targetId = relatesTo.event_id as string;
				setEvents(
					produce((draft) => {
						const idx = draft.findIndex((e) => e.eventId === targetId);
						if (idx >= 0) {
							const targetEvent = findWindowEvent(targetId);
							if (targetEvent) {
								draft[idx] = projectEvent(targetEvent, room);
							}
						}
					}),
				);
			}
			return;
		}

		// Handle edit events — update the original message in place,
		// and track failed echoes so the UI can offer Retry/Discard.
		const relType = event.getContent()?.["m.relates_to"]?.rel_type;
		if (relType === "m.replace") {
			if (event.status === EventStatus.NOT_SENT) {
				upsertPendingEdit(event);
			}
			const targetId = event.getContent()?.["m.relates_to"]?.event_id;
			if (typeof targetId === "string") {
				handleEdit(room, targetId);
			}
			return;
		}

		// A live MatrixRTC call-member event can change both per-user liveness
		// (suppressed duplicate joins / premature leaves) and the set of
		// synthesized expiry leaves, so recompute the whole window — rather
		// than incrementally pushing a single row — to keep notices and the
		// expiry timer consistent with the bulk rebuild (#215 / #219).
		// Liveness is causal, so this never rewrites a correct earlier row.
		if (event.getType() === CALL_MEMBER_EVENT_TYPE) {
			if (followingLive && currentTimelineWindow) {
				rebuildEventsFromWindow(room);
				return;
			}
			// Degraded (scrolled up, or no window after a failed load): fall
			// back to single-event suppression so a duplicate/premature live
			// leave is still hidden; synthetic expiry leaves are recomputed on
			// the next full rebuild.
			let suppressedCallIds: ReadonlySet<string> | undefined;
			if (currentTimelineWindow) {
				const windowEvents = currentTimelineWindow.getEvents();
				const ordered = windowEvents.some((e) => e === event)
					? windowEvents
					: [...windowEvents, event];
				suppressedCallIds = computeCallTimelineNotices(
					ordered,
					serverTime.now(),
				).suppressed;
			}
			if (!isRowDisplayable(event, room, suppressedCallIds)) return;
			if (!event.getId() || !followingLive) return;
			setEvents(
				produce((draft) => {
					draft.push(projectEvent(event, room, suppressedCallIds));
					capStoreToRealLimit(draft, windowLimit);
				}),
			);
			return;
		}

		if (!isRowDisplayable(event, room)) {
			if (event.getType() === "m.room.redaction") {
				const redactedId = event.event.redacts;
				if (typeof redactedId === "string") {
					// Pending redactions (status is non-null) get tracked so the
					// target can render a "Deleting…" overlay. handleRedaction
					// still runs for both pending and confirmed redactions —
					// for pending, it's a no-op recompute since the SDK hasn't
					// cleared the target's content yet.
					if (event.status) {
						recordPendingRedaction(event);
					}
					handleRedaction(room, redactedId);
				}
			}
			return;
		}

		// Displayable failed edit echoes are tracked above via the
		// existing m.replace branch — no extra handling needed here.

		if (!event.getId()) return;

		// When not following live, don't add new displayable events to the
		// store. canLoadNewer was already set above for the skipped extend.
		if (!followingLive) return;

		setEvents(
			produce((draft) => {
				draft.push(projectEvent(event, room));
				// Keep the store bounded to match the TimelineWindow's limit.
				// The window evicts internally, but the store is updated
				// independently for live events.
				capStoreToRealLimit(draft, windowLimit);
			}),
		);
	}

	function onTimelineReset(
		room: Room | undefined,
		timelineSet?: EventTimelineSet,
	): void {
		if (!room || !currentRoomId || room.roomId !== currentRoomId) return;
		// Only a reset of THIS source's timeline set reloads the window
		// (main: a thread's relations-backfill reset must not reload the
		// room; thread: another thread's or the room's reset must not
		// reload the panel).
		if (!source().acceptsTimelineSet(timelineSet)) return;
		backfillReloadAttempted = false;
		loadRoom(currentRoomId);
	}

	function onDecrypted(event: MatrixEvent): void {
		if (!currentRoomId || event.getRoomId() !== currentRoomId) return;
		const room = client.getRoom(currentRoomId);
		if (!room) return;

		const eid = event.getId();
		if (!eid) return;

		// After decryption, the event type changes from m.room.encrypted to
		// the cleartext type. Re-check displayability: encrypted reactions,
		// redactions, and edits were initially appended as m.room.encrypted
		// placeholders and must now be reclassified.
		// Decryption failures always update in place (SDK sets synthetic content).
		if (!event.isDecryptionFailure() && !isRowDisplayable(event, room)) {
			const decryptedType = event.getType();

			setEvents(
				produce((draft) => {
					const idx = draft.findIndex((e) => e.eventId === eid);
					if (idx >= 0) draft.splice(idx, 1);
				}),
			);

			if (decryptedType === "m.reaction") {
				const relatesTo = event.getContent()?.["m.relates_to"];
				if (relatesTo?.event_id) {
					const targetId = relatesTo.event_id as string;
					const rid = currentRoomId;
					// Defer to next microtask so SDK relation aggregation
					// has finished processing the newly-decrypted reaction
					queueMicrotask(() => {
						if (currentRoomId !== rid) return;
						const r = client.getRoom(rid);
						if (!r) return;
						const targetEvent = findWindowEvent(targetId);
						if (!targetEvent) return;
						const updated = projectEvent(targetEvent, r);
						setEvents(
							produce((draft) => {
								const idx = draft.findIndex((e) => e.eventId === targetId);
								if (idx >= 0) {
									draft[idx] = updated;
								}
							}),
						);
					});
				}
			} else if (decryptedType === "m.room.redaction") {
				const redactedId = event.event.redacts;
				if (typeof redactedId === "string") {
					handleRedaction(room, redactedId);
				}
			} else {
				// Encrypted edit (m.replace) — update the original message
				const relType = event.getContent()?.["m.relates_to"]?.rel_type;
				if (relType === "m.replace") {
					const targetId = event.getContent()?.["m.relates_to"]?.event_id;
					if (typeof targetId === "string") {
						handleEdit(room, targetId);
					}
				}
			}
			return;
		}

		setEvents(
			produce((draft) => {
				const idx = draft.findIndex((e) => e.eventId === eid);
				if (idx >= 0) {
					draft[idx] = projectEvent(event, room);
				}
			}),
		);
	}

	function onRoomAppeared(room: Room): void {
		if (currentRoomId && room.roomId === currentRoomId && events.length === 0) {
			loadRoom(currentRoomId);
		}
	}

	function onTyping(_event: MatrixEvent, member: RoomMember): void {
		if (member.roomId !== currentRoomId) return;
		const room = client.getRoom(currentRoomId);
		if (!room) return;
		const myUserId = client.getUserId();
		const typing: { userId: string; displayName: string }[] = [];
		for (const m of room.getMembers()) {
			if (m.typing && m.userId !== myUserId) {
				typing.push({
					userId: m.userId,
					displayName: m.name?.trim() || m.userId,
				});
			}
		}
		setTypingUsers(typing);
	}

	/**
	 * Handle SDK local-echo lifecycle transitions. Fires when an event's
	 * status changes (SENDING -> SENT / NOT_SENT / CANCELLED) and when
	 * the temporary `~local.N` event ID is replaced with the real
	 * server ID.
	 *
	 * - In-place update by old or new ID so SolidJS keying stays stable.
	 * - Recompute the parent's reactions when a reaction echo's status
	 *   transitions, since the reaction count derives from relation
	 *   events whose status this handler is updating.
	 */
	function onLocalEchoUpdated(
		event: MatrixEvent,
		eventRoom: Room,
		oldEventId?: string,
		_oldStatus?: EventStatus | null,
	): void {
		if (!eventRoom || eventRoom.roomId !== currentRoomId) return;
		// Echoes belong to exactly one source: thread sends to the thread
		// window (3d), everything else to the main window.
		if (!source().acceptsEvent(event)) return;
		const room = client.getRoom(currentRoomId);
		if (!room) return;
		const newId = event.getId();
		if (!newId) return;

		// Reaction relation: recompute the parent so the count/myReactions
		// reflect the new status (e.g. drop a NOT_SENT echo from the count),
		// and maintain the pendingReactions store so the UI can surface
		// Retry / Discard for failed reaction echoes.
		if (event.getType() === "m.reaction") {
			const targetId = event.getContent()?.["m.relates_to"]?.event_id;
			// Lifecycle: NOT_SENT upserts; a retry transition (SENDING /
			// QUEUED / ENCRYPTING), confirmation (null), or cancellation
			// (CANCELLED) removes the entry. Server-confirmed reactions
			// are tracked through normal aggregation; we only carry the
			// failure surface here.
			if (event.status === EventStatus.NOT_SENT) {
				upsertPendingReaction(event);
			} else {
				removePendingReaction(event);
			}
			if (typeof targetId === "string") {
				setEvents(
					produce((draft) => {
						const idx = draft.findIndex((e) => e.eventId === targetId);
						if (idx >= 0) {
							const targetEvent = findWindowEvent(targetId);
							if (targetEvent) {
								draft[idx] = projectEvent(targetEvent, room);
							}
						}
					}),
				);
			}
			return;
		}

		// Redaction echo: update / clear the pending-redaction overlay.
		// Confirmed (status null) clears the entry and triggers
		// `handleRedaction` to remove the target — the SDK reconciles
		// remote echoes via `handleRemoteEcho` which only fires
		// `LocalEchoUpdated` (no second `Room.timeline`), so we can't
		// rely on the existing onTimelineEvent path to remove the
		// target on confirmation.
		// CANCELLED normally arrives via the `_removed` path in
		// `onTimelineEvent` (the SDK strips the event before firing
		// LocalEchoUpdated), but treat it defensively here too in
		// case the ordering varies.
		if (event.getType() === "m.room.redaction") {
			const targetId = event.event.redacts;
			if (typeof targetId === "string") {
				if (event.status === null) {
					clearPendingRedaction(targetId);
					handleRedaction(room, targetId);
				} else if (event.status === EventStatus.CANCELLED) {
					clearPendingRedaction(targetId);
				} else {
					recordPendingRedaction(event);
				}
			}
			return;
		}

		// Edit relation (m.replace): recompute the original message so a
		// failed edit no longer appears applied, and maintain the
		// pendingEdits store so the UI can surface Retry / Discard.
		const relType = event.getContent()?.["m.relates_to"]?.rel_type;
		if (relType === "m.replace") {
			const targetId = event.getContent()?.["m.relates_to"]?.event_id;
			if (event.status === EventStatus.NOT_SENT) {
				upsertPendingEdit(event);
			} else {
				removePendingEdit(event);
			}
			if (typeof targetId === "string") {
				handleEdit(room, targetId);
			}
			return;
		}

		// Direct displayable event (message send local echo).
		setEvents(
			produce((draft) => {
				// Find by old ID (typical rekey case) or new ID (status-only
				// change). Splice out a duplicate if both somehow exist.
				const lookupId = oldEventId ?? newId;
				const oldIdx = draft.findIndex((e) => e.eventId === lookupId);
				if (oldIdx < 0) return;
				const updated = projectEvent(event, room);
				draft[oldIdx] = updated;
				if (oldEventId && oldEventId !== newId) {
					// If a separate entry already exists under the new ID
					// (race: remote echo arrived before local rekey), drop it.
					const dupIdx = draft.findIndex(
						(e, i) => i !== oldIdx && e.eventId === newId,
					);
					if (dupIdx >= 0) draft.splice(dupIdx, 1);
				}
			}),
		);
	}

	/** Get the SDK MatrixEvent for edit prefill */
	function getSourceEvent(eventId: string): MatrixEvent | undefined {
		return findWindowEvent(eventId);
	}

	// Initial load + reactive reload on room change
	createEffect(() => {
		loadRoom(roomId());
	});

	client.on(RoomEvent.Timeline, onTimelineEvent);
	client.on(RoomEvent.TimelineReset, onTimelineReset);
	client.on(RoomEvent.LocalEchoUpdated, onLocalEchoUpdated);
	client.on(MatrixEventEvent.Decrypted, onDecrypted);
	client.on(MatrixEventEvent.Replaced, onReplaced);
	client.on(ClientEvent.Room, onRoomAppeared);
	client.on(RoomMemberEvent.Typing, onTyping);

	onCleanup(() => {
		clearCallExpiryTimer();
		pollWatcher.dispose();
		threadWatcher.dispose();
		client.off(RoomEvent.Timeline, onTimelineEvent);
		client.off(RoomEvent.TimelineReset, onTimelineReset);
		client.off(RoomEvent.LocalEchoUpdated, onLocalEchoUpdated);
		client.off(MatrixEventEvent.Decrypted, onDecrypted);
		client.off(MatrixEventEvent.Replaced, onReplaced);
		client.off(ClientEvent.Room, onRoomAppeared);
		client.off(RoomMemberEvent.Typing, onTyping);
	});

	return {
		events,
		loading,
		loadingOlder,
		loadingNewer,
		canLoadOlder,
		canLoadNewer,
		loadOlderMessages,
		loadNewerMessages,
		jumpToLive,
		jumpToEvent,
		pendingScrollToId,
		consumePendingScrollToId,
		setFollowingLive,
		typingUsers,
		getSourceEvent,
		/** Raw MatrixEvents in the current window (for receipt resolution) */
		getWindowEvents(): MatrixEvent[] {
			if (!currentTimelineWindow) return [];
			return [...currentTimelineWindow.getEvents()];
		},
		/**
		 * Pending-redaction status per *target* event ID. Reactive Solid
		 * store; consumers can read `pendingRedactions[targetId]` to drive
		 * a "Deleting…" overlay or a Retry/Discard affordance on the
		 * target. Entries auto-clear when the redaction confirms or is
		 * cancelled.
		 */
		pendingRedactions,
		/**
		 * Failed reaction echoes per target event ID, then per reaction
		 * key. Each entry is the array of failed `MatrixEvent`s for that
		 * (target, key) pair so repeated retries during an outage stay
		 * discoverable. Entries auto-clear on retry, confirmation, or
		 * cancellation.
		 */
		pendingReactions,
		/**
		 * Failed edit (m.replace) echoes per target event ID. Same array
		 * semantics as `pendingReactions`. Consumers typically retry the
		 * most-recent entry and discard the whole list.
		 */
		pendingEdits,
		/**
		 * Cast or change the local user's vote on a poll (optimistic; the
		 * row's snapshot updates immediately - see PollWatcher.votePoll).
		 * An empty array is the MSC3381 vote retraction (spoiled ballot).
		 * Lives on the watcher so a future thread-scoped timeline hook
		 * (issue #303, step 3c) inherits voting without poll-specific work.
		 */
		votePoll: (pollId: string, answerIds: string[]): Promise<void> =>
			pollWatcher.votePoll(pollId, answerIds),
		/** Close a poll the local user created (see PollWatcher.endPoll). */
		endPoll: (pollId: string): Promise<void> => pollWatcher.endPoll(pollId),
	};
}
