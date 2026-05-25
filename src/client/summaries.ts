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
	/** Whether this room is a voice/video room (MSC3401 or Element video) vs a text room. */
	kind: "text" | "voice";
	/** Whether the room currently has an in-progress MatrixRTC call (any non-expired call-member). */
	callActive: boolean;
	children: string[];
}

/** State event type that MatrixRTC / Element Call use today (legacy MSC3401). */
const CALL_MEMBER_EVENT_TYPE = "org.matrix.msc3401.call.member";

/**
 * Default membership expiry used when a MatrixRTC per-device membership omits
 * `expires`. Mirrors `DEFAULT_EXPIRE_DURATION` in matrix-js-sdk's
 * `CallMembership` (4 hours).
 */
const DEFAULT_CALL_MEMBERSHIP_EXPIRE_MS = 4 * 60 * 60 * 1000;

/**
 * Whether `room` has any live MatrixRTC per-device membership. Mirrors the
 * filtering applied by matrix-js-sdk's `MatrixRTCSession`:
 *  - empty content → user left, ignore.
 *  - modern MSC4143 per-device shape (flat content with `application`) →
 *    live if `created_ts + (expires ?? 4h)` has not yet passed (and the user
 *    is still joined to the room).
 *  - legacy `{ memberships: [...] }` shape → deprecated, ignored (matches
 *    matrix-js-sdk's `quickFilterNonRelevantContents`). Stale events of this
 *    shape commonly linger in room state and would otherwise produce a
 *    permanent "call active" indicator.
 *
 * Derived directly from room state rather than via `client.matrixRTC` so it is
 * robust to SDK startup ordering.
 *
 * Note: `callActive` is only recomputed when a new call-member state event
 * arrives. Memberships that lapse via `expires` without a follow-up event
 * leave the flag stuck on until the next state update. Tracked as #98.
 */
export function isCallActive(room: Room): boolean {
	const events = room.currentState.getStateEvents(CALL_MEMBER_EVENT_TYPE);
	if (events.length === 0) return false;
	const now = Date.now();
	for (const ev of events) {
		const content = ev.getContent() as {
			application?: unknown;
			call_id?: unknown;
			device_id?: unknown;
			focus_active?: { type?: unknown };
			foci_preferred?: unknown;
			created_ts?: number;
			expires?: number;
			[k: string]: unknown;
		};
		const keys = Object.keys(content);
		// Empty / tombstone events mean "left the call".
		if (keys.length === 0) continue;
		// Only the modern flat per-device MSC4143 shape (application + flat
		// keys) is considered. The deprecated `{ memberships: [...] }` shape
		// is intentionally ignored to match matrix-js-sdk behavior; stale
		// events of that shape commonly linger in room state.
		if (keys.length <= 1 || content.application !== "m.call") continue;
		// Mirror matrix-js-sdk's `checkSessionsMembershipData`: require the
		// fields the SDK treats as mandatory so malformed events don't light
		// the indicator.
		if (
			typeof content.call_id !== "string" ||
			typeof content.device_id !== "string" ||
			typeof content.focus_active?.type !== "string"
		) {
			continue;
		}
		// Only count memberships for the default room call slot. The SDK's
		// `MatrixRTCSessionManager` filters by `slotDescription.id === "ROOM"`,
		// with a back-compat shim that treats empty-string `call_id` as
		// `"ROOM"` (see `CallMembership.slotId`). Memberships with any other
		// `call_id` (e.g. nested breakout sessions) are ignored — they belong
		// to a different RTC session, not the room's primary call.
		if (content.call_id !== "" && content.call_id !== "ROOM") continue;
		// `foci_preferred` is optional, but if present must be an array of
		// `{ type: string, ... }` transport objects (matches SDK).
		if (content.foci_preferred !== undefined) {
			if (!Array.isArray(content.foci_preferred)) continue;
			let fociValid = true;
			for (const f of content.foci_preferred) {
				if (
					typeof f !== "object" ||
					f === null ||
					typeof (f as { type?: unknown }).type !== "string"
				) {
					fociValid = false;
					break;
				}
			}
			if (!fociValid) continue;
		}
		// Mirror SDK `checkSessionsMembershipData`: if `created_ts`, `scope`,
		// or `m.call.intent` are present they must be of the expected type;
		// otherwise the SDK rejects the event entirely. (The SDK does NOT
		// type-check `expires` — see the longer note at the expiry-calc step
		// below for what happens with non-numeric `expires`.)
		if (
			content.created_ts !== undefined &&
			typeof content.created_ts !== "number"
		) {
			continue;
		}
		if (content.scope !== undefined && typeof content.scope !== "string") {
			continue;
		}
		const callIntent = (content as Record<string, unknown>)["m.call.intent"];
		if (callIntent !== undefined && typeof callIntent !== "string") {
			continue;
		}
		const createdTs = content.created_ts ?? ev.getTs();
		// Mirror SDK exactly: `data.expires ?? DEFAULT_EXPIRE_DURATION`. The
		// SDK does NOT type-check `expires`, so a non-numeric runtime value
		// (e.g. `"garbage"`, `{}`) flows through. When that happens
		// `createdTs + expires` produces a string via JS coercion; the
		// subsequent `<= now` comparison coerces that string to a number
		// (typically NaN), and any NaN comparison is `false` — so the
		// membership is treated as not-expired. This matches SDK behavior
		// because the SDK's `isExpired()` uses the same arithmetic on the
		// same untyped value and arrives at the same result.
		const expires = content.expires ?? DEFAULT_CALL_MEMBERSHIP_EXPIRE_MS;
		if ((createdTs as number) + (expires as number) <= now) continue;
		// Skip memberships from users who are no longer joined to the room.
		// Also skip events with no sender (SDK rejects these in
		// `CallMembership.membershipDataFromMatrixEvent`).
		const sender = ev.getSender();
		if (!sender || room.getMember(sender)?.membership !== "join") continue;
		return true;
	}
	return false;
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
	const kind: RoomSummary["kind"] =
		room.isCallRoom() || room.isElementVideoRoom() ? "voice" : "text";

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
		kind,
		callActive: isCallActive(room),
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
	if (
		type !== "m.room.message" &&
		type !== "m.room.encrypted" &&
		type !== "m.sticker"
	) {
		return false;
	}
	// Filter out edits — they update existing messages, not new ones
	// NOTE: encrypted edits arrive as m.room.encrypted and won't expose
	// m.relates_to until decryption. A future improvement should listen
	// for MatrixEventEvent.Decrypted to correct the sidebar preview.
	const relType = event.getContent()?.["m.relates_to"]?.rel_type;
	if (relType === "m.replace") return false;
	return true;
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

		if (!isDisplayableMessage(event)) {
			// Edit events — refresh lastMessage if the edited event was the latest
			const relType = event.getContent()?.["m.relates_to"]?.rel_type;
			if (relType === "m.replace") {
				// Defer so SDK aggregation applies the edit to the original event
				queueMicrotask(() => {
					const timeline = room.getLiveTimeline().getEvents();
					for (let i = timeline.length - 1; i >= 0; i--) {
						const ev = timeline[i];
						if (isDisplayableMessage(ev)) {
							if (summaries[room.roomId]) {
								setSummaries(room.roomId, "lastMessage", buildLastMessage(ev));
							}
							break;
						}
					}
				});
			}
			return;
		}

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
		} else if (type === CALL_MEMBER_EVENT_TYPE) {
			const active = isCallActive(room);
			if (summaries[room.roomId].callActive !== active) {
				setSummaries(room.roomId, "callActive", active);
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
