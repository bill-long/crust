import {
	EventStatus,
	type EventTimelineSet,
	M_POLL_START,
	type MatrixClient,
	type MatrixEvent,
	type Room,
	THREAD_RELATION_TYPE,
} from "matrix-js-sdk";
import { CALL_MEMBER_EVENT_TYPE } from "../../../client/summaries";
import {
	isVoiceMessageContent,
	parseVoiceInfo,
} from "../../../lib/voiceMessage";
import { extractGifUrl } from "../../gif/gifUrl";
import {
	type EncryptedFileInfo,
	parseEncryptedFile,
} from "../composer/media/attachmentCrypto";
import type { PollWatcher } from "../poll/pollWatcher";
import type { ThreadWatcher } from "../threads/threadWatcher";
import {
	buildMembershipTransition,
	buildStateNotice,
	isStateNoticeType,
} from "./stateNotice";
import {
	buildReplySnippet,
	hasControlChar,
	sanitizeMultiline,
} from "./timelineHelpers";
import type { ReactionAggregate, TimelineEvent } from "./timelineTypes";

export function eventToTimelineEvent(
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
	// Server-latched relation name, not a literal: mirrors Gate S
	// (threadEvents.ts) so pre-stable servers stay in sync.
	const isThreadFallbackReply =
		relatesTo?.rel_type === THREAD_RELATION_TYPE.name &&
		relatesTo.is_falling_back === true;
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
