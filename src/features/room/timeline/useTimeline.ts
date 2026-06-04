import {
	ClientEvent,
	Direction,
	EventStatus,
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
import { extractGifUrl } from "../../gif/gifUrl";

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
	imageUrl: string | null;
	/**
	 * Intrinsic pixel dimensions of `imageUrl`, parsed from
	 * `content.info.w` / `content.info.h` for `m.image` / `m.sticker`
	 * events. Used by the renderer to reserve layout space *before*
	 * the image loads — eliminates the "row grows on image load" jump
	 * that confuses the virtualizer on hard refresh.
	 * Null when either dimension is missing, non-numeric, non-finite,
	 * or non-positive.
	 */
	imageWidth: number | null;
	imageHeight: number | null;
	/**
	 * Full-resolution http URL for the image, suitable for the lightbox.
	 * Built from the same mxc URI as `imageUrl` but without scale/thumb
	 * params. Only populated for `m.image` (not `m.sticker`, not GIF
	 * text) so the lightbox gallery doesn't accidentally include
	 * sticker-only or third-party gif rows. Null when the content has
	 * no usable mxc URL.
	 */
	imageFullUrl: string | null;
	/** Mimetype from `content.info.mimetype`, e.g. `"image/png"`. */
	imageMimetype: string | null;
	/** Byte size from `content.info.size`, when present. */
	imageSize: number | null;
	/**
	 * User-facing filename: prefers `content.filename` (newer Matrix
	 * spec), falls back to `content.body` when it looks like a filename
	 * (non-empty, contains no newlines). Null otherwise.
	 */
	imageFilename: string | null;
	/**
	 * True when the image is an encrypted attachment (source was
	 * `content.file`, not `content.url`). The lightbox uses this to
	 * show an unsupported-decryption placeholder rather than a broken
	 * `<img>` of ciphertext.
	 */
	imageIsEncrypted: boolean;
	isEncrypted: boolean;
	isDecryptionFailure: boolean;
	isEdited: boolean;
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
}

// Reject any ASCII control character (C0 range 0x00–0x1F, plus DEL 0x7F).
// Used to guard user-controlled strings that flow into UI labels (filenames,
// the lightbox header, download attributes, etc.) so a CR/LF/NUL/etc. can't
// corrupt rendering or downstream consumers.
function hasControlChar(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x20 || c === 0x7f) return true;
	}
	return false;
}

function eventToTimelineEvent(
	event: MatrixEvent,
	room: Room,
	client: MatrixClient,
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

	let imageUrl: string | null = null;
	let imageFullUrl: string | null = null;
	const encryptedMxc =
		typeof content.file?.url === "string" && content.file.url.length > 0
			? content.file.url
			: null;
	const plainMxc =
		typeof content.url === "string" && content.url.length > 0
			? content.url
			: null;
	const mxcUrl = plainMxc || encryptedMxc;
	const imageIsEncrypted = !plainMxc && encryptedMxc !== null;
	if (mxcUrl) {
		imageUrl = client.mxcUrlToHttp(mxcUrl, 800, 600, "scale") ?? null;
		imageFullUrl = client.mxcUrlToHttp(mxcUrl) ?? null;
	}

	// Image metadata used by the lightbox. Only meaningful for true
	// m.image events — sticker/GIF rows aren't part of the gallery so
	// we don't bother populating these fields for them.
	const isPlainImage = content.msgtype === "m.image";
	const infoMime =
		isPlainImage && typeof content.info?.mimetype === "string"
			? content.info.mimetype
			: null;
	const infoSize =
		isPlainImage &&
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
		isPlainImage &&
		typeof content.filename === "string" &&
		content.filename.trim().length > 0
			? content.filename
			: isPlainImage && typeof content.body === "string"
				? content.body
				: null;
	// Treat whitespace-only, multi-line, or otherwise control-char-bearing
	// bodies as "no filename" — `m.image` events often carry a caption-style
	// body that isn't actually a filename, and any ASCII control char
	// (LF, CR, NUL, DEL, etc.) would corrupt UI labels / the lightbox header
	// if used directly.
	const trimmedFilename = rawFilename?.trim();
	const imageFilename =
		trimmedFilename && !hasControlChar(trimmedFilename)
			? trimmedFilename
			: null;

	// Image / sticker intrinsic dimensions, used by `TimelineItem` to
	// reserve the layout box before the image decodes. Gated on
	// msgtype / type so non-image events with an `info` block (e.g. an
	// uncommon m.file payload that happens to carry a `w`/`h`) don't
	// produce misleading non-null values on the event projection.
	// Also accept m.text messages whose entire body is a recognized
	// GIF provider URL (our Composer attaches `info.w/h` to those so
	// the GIF row can reserve its box exactly like m.image does).
	const bodyForGifCheck = typeof content.body === "string" ? content.body : "";
	const isGifText =
		content.msgtype === "m.text" && extractGifUrl(bodyForGifCheck) !== null;
	const isImageLike =
		content.msgtype === "m.image" ||
		event.getType() === "m.sticker" ||
		isGifText;
	const rawW = isImageLike ? content.info?.w : undefined;
	const rawH = isImageLike ? content.info?.h : undefined;
	const validW = typeof rawW === "number" && Number.isFinite(rawW) && rawW > 0;
	const validH = typeof rawH === "number" && Number.isFinite(rawH) && rawH > 0;
	// All-or-nothing: a single dimension can't reserve a usable
	// aspect-ratio box, so only expose dims when both are valid.
	const imageWidth = validW && validH ? rawW : null;
	const imageHeight = validW && validH ? rawH : null;

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
			const relationsGroup = room
				.getUnfilteredTimelineSet()
				.relations?.getChildEventsForEvent(
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
		imageUrl,
		imageWidth,
		imageHeight,
		imageFullUrl: isPlainImage ? imageFullUrl : null,
		imageMimetype: infoMime,
		imageSize: infoSize,
		imageFilename,
		imageIsEncrypted: isPlainImage && imageIsEncrypted,
		isEncrypted: event.isEncrypted(),
		isDecryptionFailure: event.isEncrypted() && event.isDecryptionFailure(),
		isEdited,
		reactions,
		myReactions,
		status: event.status ?? null,
	};
}

function isDisplayable(event: MatrixEvent): boolean {
	const type = event.getType();
	if (
		type !== "m.room.message" &&
		type !== "m.room.encrypted" &&
		type !== "m.sticker"
	) {
		return false;
	}
	// Filter out message edits (m.replace) — they update existing events
	const relType = event.getContent()?.["m.relates_to"]?.rel_type;
	if (relType === "m.replace") return false;
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
	return true;
}

const WINDOW_LIMIT = 2000;
const INITIAL_WINDOW_SIZE = 500;

export interface UseTimelineOptions {
	windowLimit?: number;
	initialWindowSize?: number;
}

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

	/** Find a raw MatrixEvent in the current window by ID */
	function findWindowEvent(eventId: string): MatrixEvent | undefined {
		if (!currentTimelineWindow) return undefined;
		return currentTimelineWindow.getEvents().find((e) => e.getId() === eventId);
	}

	/** Rebuild the displayable events store from the current window */
	function rebuildEventsFromWindow(room: Room): void {
		if (!currentTimelineWindow) return;
		const matrixEvents = currentTimelineWindow.getEvents();
		const displayable = matrixEvents
			.filter((e) => isDisplayable(e) && e.getId())
			.map((e) => eventToTimelineEvent(e, room, client));
		setEvents(reconcile(displayable, { key: "eventId", merge: false }));
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

		setEvents(
			produce((draft) => {
				let trimTo = 0;
				while (trimTo < draft.length && !windowIds.has(draft[trimTo].eventId)) {
					trimTo++;
				}
				if (trimTo > 0) {
					draft.splice(0, trimTo);
				}
			}),
		);
	}

	function loadRoom(rid: string): void {
		if (rid !== currentRoomId) {
			backfillReloadAttempted = false;
			// Clear stale events immediately on room switch so the view
			// shows the loading spinner (events.length === 0) instead of
			// the previous room's messages under the new room header.
			setEvents(reconcile([], { key: "eventId", merge: false }));
		}
		currentRoomId = rid;
		roomGeneration++;
		const gen = roomGeneration;
		currentTimelineWindow = null;
		deferredLiveCount = 0;
		followingLive = true;
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

		const timelineSet = room.getUnfilteredTimelineSet();
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
	let paginationRoomId: string | null = null;
	let paginationNewerRoomId: string | null = null;

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

		roomGeneration++;
		const gen = roomGeneration;
		const timelineSet = room.getUnfilteredTimelineSet();
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
		setEvents(
			produce((draft) => {
				const idx = draft.findIndex((e) => e.eventId === redactedId);
				if (idx >= 0) {
					const sourceEvent = findWindowEvent(redactedId);
					if (sourceEvent) {
						if (isDisplayable(sourceEvent)) {
							draft[idx] = eventToTimelineEvent(sourceEvent, room, client);
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
						draft[i] = eventToTimelineEvent(evt, room, client);
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
			const updated = eventToTimelineEvent(targetEvent, room, client);
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
					draft[idx] = eventToTimelineEvent(originalEvent, room, client);
				}
			}),
		);
	}

	function onTimelineEvent(
		event: MatrixEvent,
		eventRoom: Room | undefined,
		_toStart: boolean | undefined,
		removed: boolean | undefined,
		data: { liveEvent?: boolean },
	): void {
		if (!eventRoom || eventRoom.roomId !== currentRoomId) return;

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
								if (idx >= 0 && isDisplayable(targetEvent)) {
									draft[idx] = eventToTimelineEvent(
										targetEvent,
										eventRoom,
										client,
									);
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
								draft[idx] = eventToTimelineEvent(targetEvent, room, client);
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

		if (!isDisplayable(event)) {
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
				draft.push(eventToTimelineEvent(event, room, client));
				// Keep the store bounded to match the TimelineWindow's limit.
				// The window evicts internally, but the store is updated
				// independently for live events.
				if (draft.length > windowLimit) {
					draft.splice(0, draft.length - windowLimit);
				}
			}),
		);
	}

	function onTimelineReset(room: Room | undefined): void {
		if (!room || !currentRoomId || room.roomId !== currentRoomId) return;
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
		if (!event.isDecryptionFailure() && !isDisplayable(event)) {
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
						const updated = eventToTimelineEvent(targetEvent, r, client);
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
					draft[idx] = eventToTimelineEvent(event, room, client);
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
								draft[idx] = eventToTimelineEvent(targetEvent, room, client);
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
				const updated = eventToTimelineEvent(event, room, client);
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
	};
}
