import {
	ClientEvent,
	EventType,
	type MatrixClient,
	type MatrixEvent,
	NotificationCountType,
	type Room,
	RoomEvent,
	RoomStateEvent,
} from "matrix-js-sdk";
import { createStore, produce, type SetStoreFunction } from "solid-js/store";

export interface RoomSummary {
	roomId: string;
	name: string;
	avatarUrl: string | null;
	lastMessage: { body: string; sender: string; timestamp: number } | null;
	unreadCount: number;
	highlightCount: number;
	membership: string;
	isEncrypted: boolean;
	isDirect: boolean;
	isSpace: boolean;
	children: string[];
}

export type SummariesStore = Record<string, RoomSummary>;

function getSpaceChildren(room: Room): string[] {
	const children: string[] = [];
	const childEvents = room.currentState.getStateEvents("m.space.child");
	for (const ev of childEvents) {
		if (ev.getContent()?.via) {
			const stateKey = ev.getStateKey();
			if (stateKey) children.push(stateKey);
		}
	}
	return children;
}

function buildSummary(
	room: Room,
	baseUrl: string,
	dmRoomIds: Set<string>,
): RoomSummary {
	// Find the most recent displayable event for the lastMessage preview
	let lastMessage: RoomSummary["lastMessage"] = null;
	const timeline = room.getLiveTimeline().getEvents();
	for (let i = timeline.length - 1; i >= 0; i--) {
		const ev = timeline[i];
		if (isDisplayableMessage(ev)) {
			lastMessage = buildLastMessage(ev);
			break;
		}
	}

	const createEvent = room.currentState.getStateEvents("m.room.create", "");
	const isSpace = createEvent?.getContent()?.type === "m.space";

	return {
		roomId: room.roomId,
		name: room.name,
		avatarUrl: room.getAvatarUrl(baseUrl, 48, 48, "crop") ?? null,
		lastMessage,
		unreadCount: room.getUnreadNotificationCount(NotificationCountType.Total),
		highlightCount: room.getUnreadNotificationCount(
			NotificationCountType.Highlight,
		),
		membership: room.getMyMembership(),
		isEncrypted: room.hasEncryptionStateEvent(),
		isDirect: dmRoomIds.has(room.roomId),
		isSpace,
		children: isSpace ? getSpaceChildren(room) : [],
	};
}

function getDmRoomIds(client: MatrixClient): Set<string> {
	const dmEvent = client.getAccountData(EventType.Direct);
	if (!dmEvent) return new Set();
	const content = dmEvent.getContent();
	const ids = new Set<string>();
	for (const userId of Object.keys(content)) {
		const rooms = content[userId];
		if (Array.isArray(rooms)) {
			for (const roomId of rooms) {
				if (typeof roomId === "string") {
					ids.add(roomId);
				}
			}
		}
	}
	return ids;
}

function isDisplayableMessage(event: MatrixEvent): boolean {
	const type = event.getType();
	return (
		type === "m.room.message" ||
		type === "m.room.encrypted" ||
		type === "m.sticker"
	);
}

function buildLastMessage(event: MatrixEvent): RoomSummary["lastMessage"] {
	const content = event.getContent();
	return {
		body: content.body ?? content.msgtype ?? event.getType(),
		sender: event.getSender() ?? "",
		timestamp: event.getTs(),
	};
}

export function createSummariesStore(client: MatrixClient): {
	summaries: SummariesStore;
	setSummaries: SetStoreFunction<SummariesStore>;
	init: () => void;
	cleanup: () => void;
} {
	const [summaries, setSummaries] = createStore<SummariesStore>({});
	const baseUrl = client.getHomeserverUrl();

	let dmRoomIds = new Set<string>();

	function upsertRoom(room: Room): void {
		setSummaries(
			produce((s) => {
				s[room.roomId] = buildSummary(room, baseUrl, dmRoomIds);
			}),
		);
	}

	// --- Client-level event handlers ---

	function onNewRoom(room: Room): void {
		upsertRoom(room);
	}

	function onDeleteRoom(roomId: string): void {
		setSummaries(
			produce((s) => {
				delete s[roomId];
			}),
		);
	}

	function onRoomName(room: Room): void {
		if (!summaries[room.roomId]) {
			upsertRoom(room);
			return;
		}
		setSummaries(room.roomId, "name", room.name);
	}

	function onRoomTimeline(
		event: MatrixEvent,
		room: Room | undefined,
		_toStartOfTimeline: boolean | undefined,
		_removed: boolean | undefined,
		data: { liveEvent?: boolean },
	): void {
		if (!room || !data.liveEvent) return;

		// Ensure room exists in store before field-level updates
		if (!summaries[room.roomId]) {
			upsertRoom(room);
		}

		// Update unread counts on any live event (counts change server-side)
		updateUnreadCounts(room);

		if (!isDisplayableMessage(event)) return;

		setSummaries(room.roomId, "lastMessage", buildLastMessage(event));
	}

	function updateUnreadCounts(room: Room): void {
		if (!summaries[room.roomId]) return;
		setSummaries(
			room.roomId,
			"unreadCount",
			room.getUnreadNotificationCount(NotificationCountType.Total),
		);
		setSummaries(
			room.roomId,
			"highlightCount",
			room.getUnreadNotificationCount(NotificationCountType.Highlight),
		);
	}

	function onReceipt(_event: MatrixEvent, room: Room): void {
		updateUnreadCounts(room);
	}

	function onMyMembership(room: Room): void {
		if (!summaries[room.roomId]) {
			upsertRoom(room);
			return;
		}
		setSummaries(room.roomId, "membership", room.getMyMembership());
	}

	function onAccountData(event: MatrixEvent): void {
		if (event.getType() !== EventType.Direct) return;
		dmRoomIds = getDmRoomIds(client);
		setSummaries(
			produce((s) => {
				for (const roomId of Object.keys(s)) {
					s[roomId].isDirect = dmRoomIds.has(roomId);
				}
			}),
		);
	}

	function onRoomStateEvents(event: MatrixEvent): void {
		const roomId = event.getRoomId();
		if (!roomId) return;
		const room = client.getRoom(roomId);
		if (!room) return;
		if (!summaries[room.roomId]) {
			upsertRoom(room);
			return;
		}
		const type = event.getType();

		if (type === "m.room.encryption") {
			setSummaries(room.roomId, "isEncrypted", room.hasEncryptionStateEvent());
		} else if (type === "m.room.avatar") {
			setSummaries(
				room.roomId,
				"avatarUrl",
				room.getAvatarUrl(baseUrl, 48, 48, "crop") ?? null,
			);
		} else if (type === "m.space.child") {
			const createEv = room.currentState.getStateEvents("m.room.create", "");
			if (createEv?.getContent()?.type === "m.space") {
				setSummaries(room.roomId, "children", getSpaceChildren(room));
			}
		}
	}

	function init(): void {
		dmRoomIds = getDmRoomIds(client);

		for (const room of client.getVisibleRooms()) {
			upsertRoom(room);
		}

		client.on(ClientEvent.Room, onNewRoom);
		client.on(ClientEvent.DeleteRoom, onDeleteRoom);
		client.on(RoomEvent.Name, onRoomName);
		client.on(RoomEvent.Timeline, onRoomTimeline);
		client.on(RoomEvent.Receipt, onReceipt);
		client.on(RoomEvent.MyMembership, onMyMembership);
		client.on(ClientEvent.AccountData, onAccountData);
		client.on(RoomStateEvent.Events, onRoomStateEvents);
	}

	function cleanup(): void {
		client.off(ClientEvent.Room, onNewRoom);
		client.off(ClientEvent.DeleteRoom, onDeleteRoom);
		client.off(RoomEvent.Name, onRoomName);
		client.off(RoomEvent.Timeline, onRoomTimeline);
		client.off(RoomEvent.Receipt, onReceipt);
		client.off(RoomEvent.MyMembership, onMyMembership);
		client.off(ClientEvent.AccountData, onAccountData);
		client.off(RoomStateEvent.Events, onRoomStateEvents);
	}

	return { summaries, setSummaries, init, cleanup };
}
