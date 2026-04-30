import {
	ClientEvent,
	type MatrixClient,
	type MatrixEvent,
	MatrixEventEvent,
	type Room,
	RoomEvent,
} from "matrix-js-sdk";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { createStore, produce } from "solid-js/store";

export interface TimelineEvent {
	eventId: string;
	sender: string;
	senderName: string;
	timestamp: number;
	type: string;
	msgtype: string;
	body: string;
	formattedBody: string | undefined;
	imageUrl: string | null;
	imageInfo: { w?: number; h?: number; mimetype?: string } | null;
	isEncrypted: boolean;
	isDecryptionFailure: boolean;
	reactions: Record<string, number>;
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
	if (content.url && typeof content.url === "string") {
		imageUrl = client.mxcUrlToHttp(content.url, 800, 600, "scale") ?? null;
	}

	// Aggregate reactions from SDK relations
	const reactions: TimelineEvent["reactions"] = {};
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
		sender,
		senderName: member?.name ?? sender,
		timestamp: event.getTs(),
		type: event.getType(),
		msgtype: content.msgtype ?? "",
		body: content.body ?? "",
		formattedBody:
			content.format === "org.matrix.custom.html"
				? content.formatted_body
				: undefined,
		imageUrl,
		imageInfo: content.info ?? null,
		isEncrypted: event.isEncrypted(),
		isDecryptionFailure: event.isEncrypted() && event.isDecryptionFailure(),
		reactions,
	};
}

function isDisplayable(event: MatrixEvent): boolean {
	const type = event.getType();
	return (
		type === "m.room.message" ||
		type === "m.room.encrypted" ||
		type === "m.sticker"
	);
}

export function useTimeline(client: MatrixClient, roomId: () => string) {
	const [events, setEvents] = createStore<TimelineEvent[]>([]);
	const [loading, setLoading] = createSignal(true);

	let currentRoomId: string | null = null;

	function loadRoom(rid: string): void {
		currentRoomId = rid;
		const room = client.getRoom(rid);
		if (!room) {
			setEvents([]);
			setLoading(true);
			return;
		}

		const timeline = room.getLiveTimeline().getEvents();
		const displayable = timeline
			.filter(isDisplayable)
			.map((e) => eventToTimelineEvent(e, room, client));
		setEvents(displayable);
		setLoading(false);
	}

	function onTimelineEvent(
		event: MatrixEvent,
		eventRoom: Room | undefined,
		_toStart: boolean | undefined,
		_removed: boolean | undefined,
		data: { liveEvent?: boolean },
	): void {
		if (!eventRoom || eventRoom.roomId !== currentRoomId) return;
		if (!data.liveEvent) return;

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

		if (!isDisplayable(event)) {
			// Handle redactions by updating only the affected event
			if (event.getType() === "m.room.redaction") {
				const redactedId = event.event.redacts;
				if (typeof redactedId === "string") {
					setEvents(
						produce((draft) => {
							const idx = draft.findIndex((e) => e.eventId === redactedId);
							if (idx >= 0) {
								const sourceEvent = room
									.getLiveTimeline()
									.getEvents()
									.find((e) => e.getId() === redactedId);
								if (sourceEvent) {
									draft[idx] = eventToTimelineEvent(sourceEvent, room, client);
								} else {
									draft.splice(idx, 1);
								}
							}
						}),
					);
				}
			}
			return;
		}

		setEvents(
			produce((draft) => {
				draft.push(eventToTimelineEvent(event, room, client));
			}),
		);
	}

	function onTimelineReset(room: Room | undefined): void {
		if (!room || room.roomId !== currentRoomId) return;
		loadRoom(currentRoomId);
	}

	function onDecrypted(event: MatrixEvent): void {
		if (!currentRoomId || event.getRoomId() !== currentRoomId) return;
		const room = client.getRoom(currentRoomId);
		if (!room) return;

		const eid = event.getId();
		if (!eid) return;

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
		if (room.roomId === currentRoomId && loading()) {
			loadRoom(currentRoomId);
		}
	}

	// Initial load + reactive reload on room change
	createEffect(() => {
		loadRoom(roomId());
	});

	client.on(RoomEvent.Timeline, onTimelineEvent);
	client.on(RoomEvent.TimelineReset, onTimelineReset);
	client.on(MatrixEventEvent.Decrypted, onDecrypted);
	client.on(ClientEvent.Room, onRoomAppeared);

	onCleanup(() => {
		client.off(RoomEvent.Timeline, onTimelineEvent);
		client.off(RoomEvent.TimelineReset, onTimelineReset);
		client.off(MatrixEventEvent.Decrypted, onDecrypted);
		client.off(ClientEvent.Room, onRoomAppeared);
	});

	return { events, loading };
}
