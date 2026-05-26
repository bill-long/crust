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
import {
	createServerTimeTracker,
	MATERIAL_OFFSET_CHANGE_MS,
	type ServerTimeTracker,
} from "./serverTime";

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
 * A stuck-active indicator caused by silently-expiring memberships (no
 * follow-up state event) is mitigated by the per-room expiry timer in
 * `createSummariesStore`, which re-evaluates this function when the
 * earliest known membership expires.
 *
 * `now` defaults to `Date.now()` for backward compatibility. Callers that
 * have a server-time-corrected clock (see `createServerTimeTracker`) should
 * pass it explicitly so this check is robust to client clock skew.
 */
export function isCallActive(room: Room, now: number = Date.now()): boolean {
	for (const _ of iterValidCallMemberships(room, now)) return true;
	return false;
}

/**
 * The earliest absolute timestamp (ms since epoch) at which a currently-valid
 * MatrixRTC membership in `room` will expire. Returns `null` when no live
 * membership exists, or when the only live memberships have non-numeric
 * `expires` values (which the SDK treats as never-expiring — see the note in
 * `iterValidCallMemberships`). Used by `createSummariesStore` to schedule
 * a re-evaluation of `callActive` for the room.
 */
export function getNextCallExpiry(room: Room, now: number): number | null {
	let earliest: number | null = null;
	for (const { expiresAt } of iterValidCallMemberships(room, now)) {
		if (!Number.isFinite(expiresAt)) continue;
		if (earliest === null || expiresAt < earliest) earliest = expiresAt;
	}
	return earliest;
}

/**
 * Iterate the call-member events in `room` that the SDK would consider live
 * relative to `now`, yielding each one's absolute expiry timestamp
 * (`created_ts + (expires ?? 4h)`). Shared by `isCallActive` (which only
 * needs the existence check) and `getNextCallExpiry` (which needs the
 * minimum). All validation rules — content shape, required fields, sender
 * still joined — are kept in this single iterator to prevent the two
 * consumers from drifting.
 */
function* iterValidCallMemberships(
	room: Room,
	now: number,
): Generator<{ expiresAt: number }> {
	const events = room.currentState.getStateEvents(CALL_MEMBER_EVENT_TYPE);
	if (events.length === 0) return;
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
		const expiresAt = (createdTs as number) + (expires as number);
		if ((expiresAt as unknown as number) <= now) continue;
		// Skip memberships from users who are no longer joined to the room.
		// Also skip events with no sender (SDK rejects these in
		// `CallMembership.membershipDataFromMatrixEvent`).
		const sender = ev.getSender();
		if (!sender || room.getMember(sender)?.membership !== "join") continue;
		yield { expiresAt: expiresAt as unknown as number };
	}
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
	now: number,
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
		callActive: isCallActive(room, now),
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
	const serverTime: ServerTimeTracker = createServerTimeTracker();

	let dmRoomIds = new Set<string>();

	// Per-room expiry timers. When `callActive` is true for a room, we
	// schedule a setTimeout that fires shortly after the earliest known
	// membership expiry so a stale-true `callActive` flips off even when no
	// follow-up call-member state event arrives. Re-armed on every relevant
	// state change, cleared on cleanup / room deletion.
	const callExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// `setTimeout` delays must fit in a signed 32-bit int. Memberships near
	// the cap (4-hour default) are well under it, but clamp defensively.
	const MAX_TIMEOUT_DELAY = 2_147_483_647;
	// Small grace so the timer fires after `now > expiresAt`, not exactly at
	// it, and re-evaluation reliably sees the membership as expired.
	const CALL_EXPIRY_GRACE_MS = 50;

	function clearCallExpiryTimer(roomId: string): void {
		const existing = callExpiryTimers.get(roomId);
		if (existing !== undefined) {
			clearTimeout(existing);
			callExpiryTimers.delete(roomId);
		}
	}

	function scheduleCallExpiryRefresh(room: Room): void {
		clearCallExpiryTimer(room.roomId);
		const now = serverTime.now();
		const next = getNextCallExpiry(room, now);
		if (next === null) return;
		// Both `next` and `now` are server-clock values; their difference
		// is the same number of milliseconds on the client clock that
		// `setTimeout` measures against, so the delay is correct.
		const delay = Math.min(
			Math.max(0, next - now + CALL_EXPIRY_GRACE_MS),
			MAX_TIMEOUT_DELAY,
		);
		const id = setTimeout(() => {
			callExpiryTimers.delete(room.roomId);
			if (!summaries[room.roomId]) return;
			const active = isCallActive(room, serverTime.now());
			if (summaries[room.roomId].callActive !== active) {
				setSummaries(room.roomId, "callActive", active);
			}
			// Re-arm if the room is still considered active (e.g. another
			// membership in the same room has a later expiry, or the value
			// flipped back to true while we were waiting).
			if (active) scheduleCallExpiryRefresh(room);
		}, delay);
		callExpiryTimers.set(room.roomId, id);
	}

	function upsertRoom(room: Room): void {
		setSummaries(
			produce((s) => {
				s[room.roomId] = buildSummary(
					room,
					baseUrl,
					dmRoomIds,
					serverTime.now(),
				);
			}),
		);
		scheduleCallExpiryRefresh(room);
	}

	/**
	 * Recompute `callActive` for every room in the store and re-arm any
	 * expiry timers. Invoked when the server-time offset shifts materially
	 * so previously-scheduled timers and previously-computed `callActive`
	 * booleans are corrected against the new offset. Pass `skipRoomId` to
	 * exclude a room that was just recomputed in the calling handler.
	 */
	function refreshAllCallActive(skipRoomId?: string): void {
		for (const roomId of Object.keys(summaries)) {
			if (roomId === skipRoomId) continue;
			const room = client.getRoom(roomId);
			if (!room) continue;
			const active = isCallActive(room, serverTime.now());
			if (summaries[roomId].callActive !== active) {
				setSummaries(roomId, "callActive", active);
			}
			scheduleCallExpiryRefresh(room);
		}
	}

	// --- Client-level event handlers ---

	function onNewRoom(room: Room): void {
		upsertRoom(room);
	}

	function onDeleteRoom(roomId: string): void {
		clearCallExpiryTimer(roomId);
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

		// Sample server-time offset from every live event before any other
		// processing so subsequent calls in this handler use the freshest
		// possible offset. If the offset shifted materially, re-evaluate
		// every room's `callActive` and re-arm timers.
		const prevOffset = serverTime.getOffsetMs();
		if (
			serverTime.sampleFromEvent(event) &&
			Math.abs(serverTime.getOffsetMs() - prevOffset) >=
				MATERIAL_OFFSET_CHANGE_MS
		) {
			refreshAllCallActive();
		}

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
		// State events also carry `unsigned.age`; sample before any
		// `isCallActive` recomputation below so the call-member fast-path
		// uses the freshest offset.
		const prevOffset = serverTime.getOffsetMs();
		const offsetChanged =
			serverTime.sampleFromEvent(event) &&
			Math.abs(serverTime.getOffsetMs() - prevOffset) >=
				MATERIAL_OFFSET_CHANGE_MS;
		if (!summaries[room.roomId]) {
			upsertRoom(room);
			// upsertRoom computed callActive with the fresh offset, so skip it.
			if (offsetChanged) refreshAllCallActive(room.roomId);
			return;
		}
		const type = event.getType();

		let currentRoomRefreshed = false;
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
			const active = isCallActive(room, serverTime.now());
			if (summaries[room.roomId].callActive !== active) {
				setSummaries(room.roomId, "callActive", active);
			}
			// Always re-arm: even when the boolean is unchanged, the earliest
			// known expiry may have shifted (new membership, renewal, etc.),
			// so the previously-scheduled timer needs to be replaced.
			scheduleCallExpiryRefresh(room);
			currentRoomRefreshed = true;
		}

		// If the offset shifted while handling this event, propagate to all
		// other rooms. Skip the current room only when the branch above
		// already recomputed it with the fresh offset.
		if (offsetChanged) {
			refreshAllCallActive(currentRoomRefreshed ? room.roomId : undefined);
		}
	}

	function init(): void {
		dmRoomIds = getDmRoomIds(client);

		// Seed the server-time tracker from existing room state before
		// building any room summaries, so `callActive` is computed against
		// the corrected clock on first paint. Walk each visible room's
		// most recent live event and its call-member state events; either
		// kind carries `unsigned.age` for server-delivered events.
		const rooms = client.getVisibleRooms();
		for (const room of rooms) {
			const timeline = room.getLiveTimeline().getEvents();
			for (let i = timeline.length - 1; i >= 0; i--) {
				if (serverTime.sampleFromEvent(timeline[i])) break;
				// Stop scanning this room after at most 5 events to avoid
				// O(N) work on large timelines; one sample per room is
				// enough to seed.
				if (timeline.length - i >= 5) break;
			}
			const callMembers = room.currentState.getStateEvents(
				CALL_MEMBER_EVENT_TYPE,
			);
			for (const ev of callMembers) serverTime.sampleFromEvent(ev);
		}

		for (const room of rooms) {
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
		for (const id of callExpiryTimers.values()) clearTimeout(id);
		callExpiryTimers.clear();
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
