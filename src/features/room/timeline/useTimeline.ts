import {
	ClientEvent,
	Direction,
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
	isEncrypted: boolean;
	isDecryptionFailure: boolean;
	isEdited: boolean;
	reactions: Record<string, number>;
	myReactions: Record<string, string>;
}

function eventToTimelineEvent(
	event: MatrixEvent,
	room: Room,
	client: MatrixClient,
): TimelineEvent {
	const content = event.getContent();
	const sender = event.getSender() ?? "";
	const member = room.getMember(sender);

	let imageUrl: string | null = null;
	const mxcUrl =
		(typeof content.url === "string" && content.url) ||
		(typeof content.file?.url === "string" && content.file.url) ||
		null;
	if (mxcUrl) {
		imageUrl = client.mxcUrlToHttp(mxcUrl, 800, 600, "scale") ?? null;
	}

	// Aggregate reactions from SDK relations
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
							reactions[key] = evSet.size;
							if (myUserId) {
								for (const ev of evSet) {
									if (ev.getSender() === myUserId) {
										const id = ev.getId();
										if (id) myReactions[key] = id;
									}
								}
							}
						}
					}
				}
			}
		}
	} catch {
		// Relations API may not be available for all events
	}

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
		isEncrypted: event.isEncrypted(),
		isDecryptionFailure: event.isEncrypted() && event.isDecryptionFailure(),
		isEdited: !!event.replacingEventId(),
		reactions,
		myReactions,
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
	// Filter out redacted events (content cleared by server)
	if (type === "m.room.message" && !event.getContent()?.msgtype) return false;
	return true;
}

const WINDOW_LIMIT = 2000;
const INITIAL_WINDOW_SIZE = 500;

export function useTimeline(client: MatrixClient, roomId: () => string) {
	const [events, setEvents] = createStore<TimelineEvent[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [loadingOlder, setLoadingOlder] = createSignal(false);
	const [canLoadOlder, setCanLoadOlder] = createSignal(true);
	const [typingUsers, setTypingUsers] = createSignal<
		{ userId: string; displayName: string }[]
	>([]);

	let currentRoomId: string | null = null;
	let backfillReloadAttempted = false;
	// Generation counter — increments on every room load. Async operations
	// capture the current generation and bail if it changed (A→B→A safety).
	let roomGeneration = 0;
	let currentTimelineWindow: TimelineWindow | null = null;

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

	function loadRoom(rid: string): void {
		if (rid !== currentRoomId) {
			backfillReloadAttempted = false;
		}
		currentRoomId = rid;
		roomGeneration++;
		const gen = roomGeneration;
		currentTimelineWindow = null;
		setLoading(true);
		setLoadingOlder(false);
		setCanLoadOlder(false);
		setTypingUsers([]);

		const room = client.getRoom(rid);
		if (!room) {
			setEvents(reconcile([], { key: "eventId", merge: false }));
			setLoading(false);
			currentTimelineWindow = null;
			return;
		}

		const timelineSet = room.getUnfilteredTimelineSet();
		const tw = new TimelineWindow(client, timelineSet, {
			windowLimit: WINDOW_LIMIT,
		});
		// Defer setting currentTimelineWindow until load completes to
		// prevent live events from calling extend() on an uninitialized
		// window during the async gap.

		tw.load(undefined, INITIAL_WINDOW_SIZE)
			.then(() => {
				if (gen !== roomGeneration) return;

				currentTimelineWindow = tw;
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
		_removed: boolean | undefined,
		data: { liveEvent?: boolean },
	): void {
		if (!eventRoom || eventRoom.roomId !== currentRoomId) return;

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

		const room = client.getRoom(currentRoomId);
		if (!room) return;

		// Extend the window to include the new live event (no HTTP request)
		if (currentTimelineWindow) {
			currentTimelineWindow.extend(Direction.Forward, 1);
		}

		// Handle reaction events by updating the target message's reactions
		if (event.getType() === "m.reaction") {
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

		// Handle edit events — update the original message in place
		const relType = event.getContent()?.["m.relates_to"]?.rel_type;
		if (relType === "m.replace") {
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
					handleRedaction(room, redactedId);
				}
			}
			return;
		}

		if (!event.getId()) return;

		setEvents(
			produce((draft) => {
				draft.push(eventToTimelineEvent(event, room, client));
				// Keep the store bounded to match the TimelineWindow's limit.
				// The window evicts internally, but the store is updated
				// independently for live events.
				if (draft.length > WINDOW_LIMIT) {
					draft.splice(0, draft.length - WINDOW_LIMIT);
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
	client.on(MatrixEventEvent.Decrypted, onDecrypted);
	client.on(MatrixEventEvent.Replaced, onReplaced);
	client.on(ClientEvent.Room, onRoomAppeared);
	client.on(RoomMemberEvent.Typing, onTyping);

	onCleanup(() => {
		client.off(RoomEvent.Timeline, onTimelineEvent);
		client.off(RoomEvent.TimelineReset, onTimelineReset);
		client.off(MatrixEventEvent.Decrypted, onDecrypted);
		client.off(MatrixEventEvent.Replaced, onReplaced);
		client.off(ClientEvent.Room, onRoomAppeared);
		client.off(RoomMemberEvent.Typing, onTyping);
	});

	return {
		events,
		loading,
		loadingOlder,
		canLoadOlder,
		loadOlderMessages,
		typingUsers,
		getSourceEvent,
		/** Raw MatrixEvents in the current window (for receipt resolution) */
		getWindowEvents(): MatrixEvent[] {
			if (!currentTimelineWindow) return [];
			return [...currentTimelineWindow.getEvents()];
		},
	};
}
