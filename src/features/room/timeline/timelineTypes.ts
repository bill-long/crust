import type { EventStatus } from "matrix-js-sdk";
import type { EncryptedFileInfo } from "../composer/media/attachmentCrypto";
import type { PollSnapshot } from "../poll/pollSnapshot";
import type { ThreadSummary } from "../threads/threadSummary";
import type { TimelineSource } from "../threads/timelineSource";
import type { MembershipTransition, StateNotice } from "./stateNotice";

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
