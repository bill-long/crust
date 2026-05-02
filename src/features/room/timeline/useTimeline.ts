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

const MAX_TIMELINE_EVENTS = 500;

export function useTimeline(client: MatrixClient, roomId: () => string) {
	const [events, setEvents] = createStore<TimelineEvent[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [loadingOlder, setLoadingOlder] = createSignal(false);
	const [canLoadOlder, setCanLoadOlder] = createSignal(true);
	const [typingUsers, setTypingUsers] = createSignal<
		{ userId: string; displayName: string }[]
	>([]);

	let currentRoomId: string | null = null;
	// Tracks whether we've already attempted a backfill reload for the
	// current room while events are empty. Prevents infinite reload loops
	// for rooms with only non-displayable events.
	let backfillReloadAttempted = false;

	function loadRoom(rid: string): void {
		// Only reset backfill flag when switching to a different room
		if (rid !== currentRoomId) {
			backfillReloadAttempted = false;
		}
		currentRoomId = rid;
		setLoading(true);
		setTypingUsers([]);

		const room = client.getRoom(rid);
		if (!room) {
			setEvents(reconcile([], { key: "eventId", merge: false }));
			setLoading(false);
			return;
		}

		const timeline = room.getLiveTimeline().getEvents();
		const displayable = timeline
			.filter((e) => isDisplayable(e) && e.getId())
			.map((e) => eventToTimelineEvent(e, room, client));
		const items =
			displayable.length > MAX_TIMELINE_EVENTS
				? displayable.slice(-MAX_TIMELINE_EVENTS)
				: displayable;
		// reconcile with key + merge:false forces a full replacement
		// including correct array length reset
		setEvents(reconcile(items, { key: "eventId", merge: false }));
		setLoading(false);

		// Check if older messages can be loaded
		const paginationToken = room
			.getLiveTimeline()
			.getPaginationToken(Direction.Backward);
		setCanLoadOlder(paginationToken !== null);
		setLoadingOlder(false);
	}

	const PAGINATION_SIZE = 50;
	let paginationRoomId: string | null = null;

	async function loadOlderMessages(): Promise<void> {
		if (loadingOlder() || !canLoadOlder() || !currentRoomId) return;

		const rid = currentRoomId;
		const room = client.getRoom(rid);
		if (!room) return;

		const timeline = room.getLiveTimeline();
		const token = timeline.getPaginationToken(Direction.Backward);
		if (!token) {
			setCanLoadOlder(false);
			return;
		}

		// Set immediately to prevent concurrent scroll-triggered requests
		setLoadingOlder(true);
		paginationRoomId = rid;

		try {
			const hasMore = await client.paginateEventTimeline(timeline, {
				backwards: true,
				limit: PAGINATION_SIZE,
			});
			// Stale room guard — both for room switch and cleanup
			if (currentRoomId !== rid) return;

			// Rebuild displayable events from the full timeline.
			// For backward pagination, keep the oldest events (head) not
			// the newest (tail), so the user sees the history they scrolled to.
			const allEvents = timeline.getEvents();
			const displayable = allEvents
				.filter((e) => isDisplayable(e) && e.getId())
				.map((e) => eventToTimelineEvent(e, room, client));
			const items =
				displayable.length > MAX_TIMELINE_EVENTS
					? displayable.slice(0, MAX_TIMELINE_EVENTS)
					: displayable;
			setEvents(reconcile(items, { key: "eventId", merge: false }));
			setCanLoadOlder(hasMore);
		} catch {
			// Pagination failed — leave current state, user can retry
		} finally {
			// Only clear loading if this is still the active pagination
			if (paginationRoomId === rid) {
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
					const sourceEvent = room
						.getLiveTimeline()
						.getEvents()
						.find((e) => e.getId() === redactedId);
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

				// Build lookup map once for O(1) access
				const timelineEvents = room.getLiveTimeline().getEvents();
				const eventMap = new Map<string, MatrixEvent>();
				for (const evt of timelineEvents) {
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
			const targetEvent = room
				.getLiveTimeline()
				.getEvents()
				.find((e) => e.getId() === targetId);
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

		// Handle reaction events by updating the target message's reactions
		if (event.getType() === "m.reaction") {
			const relatesTo = event.getContent()?.["m.relates_to"];
			if (relatesTo?.event_id) {
				const targetId = relatesTo.event_id as string;
				setEvents(
					produce((draft) => {
						const idx = draft.findIndex((e) => e.eventId === targetId);
						if (idx >= 0) {
							const targetEvent = room
								.getLiveTimeline()
								.getEvents()
								.find((e) => e.getId() === targetId);
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
				// Cap timeline size to prevent unbounded growth
				if (draft.length > MAX_TIMELINE_EVENTS) {
					draft.splice(0, draft.length - MAX_TIMELINE_EVENTS);
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
						const targetEvent = r
							.getLiveTimeline()
							.getEvents()
							.find((e) => e.getId() === targetId);
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
		if (!currentRoomId) return undefined;
		const room = client.getRoom(currentRoomId);
		if (!room) return undefined;
		return room
			.getLiveTimeline()
			.getEvents()
			.find((e) => e.getId() === eventId);
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
	};
}
