import {
	ClientEvent,
	createClient,
	EventType,
	MatrixEvent,
	Room,
	RoomStateEvent,
	RoomStickyEventsEvent,
} from "matrix-js-sdk";
import { MatrixRTCSessionEvent } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSummariesStore,
	getNextCallExpiry,
	isCallActive,
} from "./summaries";

const NOW = 1_780_000_000_000;
const USER = "@bob:example.org";
const ROOM = "!sticky:example.org";
const KEY = `_${USER}_DEVICE1`;
const IDENTITY = "c53v4dTzaQzS4pI/jouU5eCVHNPFYvNSUhL6V6MFrEA";

function sticky(
	content: Record<string, unknown> = {},
	id = "$rtc-bob",
	ttl = 60_000,
) {
	return new MatrixEvent({
		event_id: id,
		room_id: ROOM,
		sender: USER,
		type: EventType.RTCMembership,
		origin_server_ts: Date.now(),
		msc4354_sticky: { duration_ms: 60_000 },
		unsigned: { msc4354_sticky_duration_ttl_ms: ttl },
		content: {
			slot_id: "m.call#ROOM",
			member: { user_id: USER, device_id: "DEVICE1", id: "member-uuid-1" },
			application: { type: "m.call" },
			transports: {
				published: [
					{
						type: "livekit",
						livekit_service_url: "https://sfu.example.org",
						livekit_alias: ROOM,
					},
				],
				can_subscribe: ["livekit"],
			},
			versions: [],
			msc4354_sticky_key: KEY,
			...content,
		},
	});
}

function setup() {
	const client = createClient({
		baseUrl: "https://example.org",
		userId: USER,
		deviceId: "DEVICE1",
	});
	const room = new Room(ROOM, client, USER);
	room.currentState.setStateEvents([
		new MatrixEvent({
			event_id: "$join",
			room_id: ROOM,
			sender: USER,
			type: EventType.RoomMember,
			state_key: USER,
			origin_server_ts: NOW,
			content: { membership: "join", displayname: "Bob" },
		}),
	]);
	client.store.storeRoom(room);
	// Sync normally installs these client-level re-emitters. Keep the SDK's
	// actual Events -> RoomMember mutation -> Members ordering in these tests.
	client.reEmitter.reEmit(room.currentState, [
		RoomStateEvent.Events,
		RoomStateEvent.Members,
	]);
	return { client, room };
}

describe("sticky call membership delivery (#504)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("updates the room indicator on SDK sticky arrival, replacement, and expiry", () => {
		const { client, room } = setup();
		const store = createSummariesStore(client);
		store.init();
		expect(store.summaries[ROOM]?.callActive).toBe(false);
		room._unstable_addStickyEvents([sticky()]);
		expect(store.summaries[ROOM]?.callActive).toBe(true);
		vi.advanceTimersByTime(30_000);
		room._unstable_addStickyEvents([sticky({}, "$renewal", 60_000)]);
		vi.advanceTimersByTime(30_100);
		expect(store.summaries[ROOM]?.callActive).toBe(true);
		vi.advanceTimersByTime(30_000);
		expect(store.summaries[ROOM]?.callActive).toBe(false);
		store.cleanup();
	});

	it("seeds catch-up memberships and schedules TTL on the local clock despite server skew", () => {
		const { room } = setup();
		room._unstable_addStickyEvents([sticky()]);
		expect(isCallActive(room, NOW + 3_600_000)).toBe(true);
		expect(getNextCallExpiry(room, NOW + 3_600_000)).toBe(NOW + 3_660_000);
		vi.advanceTimersByTime(60_050);
		expect(isCallActive(room, NOW + 3_660_050)).toBe(false);
	});

	it("ignores malformed, other-slot, and impersonated memberships", () => {
		for (const content of [
			{ member: null },
			{ slot_id: "m.call#BREAKOUT" },
			{
				member: {
					user_id: "@eve:example.org",
					device_id: "DEVICE1",
					id: "spoof",
				},
			},
		]) {
			const { room } = setup();
			room._unstable_addStickyEvents([sticky(content)]);
			expect(isCallActive(room)).toBe(false);
		}
	});

	it.each([USER, "@eve:example.org"])(
		"scopes sticky leave tombstones to their sender (%s)",
		(sender) => {
			const { room } = setup();
			room.currentState.setStateEvents([
				new MatrixEvent({
					event_id: "$legacy",
					room_id: ROOM,
					sender: USER,
					type: EventType.GroupCallMemberPrefix,
					state_key: KEY,
					origin_server_ts: NOW,
					content: {
						application: "m.call",
						call_id: "",
						device_id: "DEVICE1",
						focus_active: {
							type: "livekit",
							focus_selection: "oldest_membership",
						},
					},
				}),
			]);
			expect(isCallActive(room)).toBe(true);
			const leave = sticky();
			leave.event.sender = sender;
			leave.event.content = { msc4354_sticky_key: KEY };
			room._unstable_addStickyEvents([leave]);
			expect(isCallActive(room)).toBe(sender !== USER);
		},
	);

	it("ignores sticky memberships when the default RTC slot is closed", () => {
		const { room } = setup();
		room._unstable_addStickyEvents([sticky()]);
		room.currentState.setStateEvents([
			new MatrixEvent({
				event_id: "$slot",
				room_id: ROOM,
				sender: USER,
				type: EventType.RTCSlot,
				state_key: "m.call#ROOM",
				origin_server_ts: NOW,
				content: { status: "closed", application: { type: "m.call" } },
			}),
		]);
		expect(isCallActive(room)).toBe(false);
	});

	it("refreshes after a participant leaves and rejoins, then rearms sticky expiry", async () => {
		const { client, room } = setup();
		room._unstable_addStickyEvents([sticky()]);
		const store = createSummariesStore(client);
		store.init();
		for (const membership of ["leave", "join"]) {
			room.currentState.setStateEvents([
				new MatrixEvent({
					event_id: `$${membership}`,
					room_id: ROOM,
					sender: USER,
					type: EventType.RoomMember,
					state_key: USER,
					origin_server_ts: NOW,
					content: { membership },
				}),
			]);
			await Promise.resolve();
			expect(store.summaries[ROOM]?.callActive).toBe(membership === "join");
		}
		vi.advanceTimersByTime(60_050);
		expect(store.summaries[ROOM]?.callActive).toBe(false);
		store.cleanup();
	});

	it("coalesces bulk SDK member events and ignores power-level notifications", async () => {
		const { client, room } = setup();
		room._unstable_addStickyEvents([sticky()]);
		const store = createSummariesStore(client);
		store.init();
		const readSticky = vi.spyOn(room, "_unstable_getStickyEvents");
		room.currentState.setStateEvents(
			Array.from(
				{ length: 30 },
				(_, i) =>
					new MatrixEvent({
						event_id: `$name-${i}`,
						room_id: ROOM,
						sender: USER,
						type: EventType.RoomMember,
						state_key: USER,
						origin_server_ts: NOW,
						content: { membership: "join", displayname: `Bob ${i}` },
					}),
			),
		);
		expect(readSticky).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(readSticky).toHaveBeenCalled();
		expect(readSticky.mock.calls.length).toBeLessThan(4);
		readSticky.mockClear();
		room.currentState.setStateEvents([
			new MatrixEvent({
				event_id: "$power",
				room_id: ROOM,
				sender: USER,
				type: EventType.RoomPowerLevels,
				state_key: "",
				origin_server_ts: NOW,
				content: { users: { [USER]: 100 } },
			}),
		]);
		await Promise.resolve();
		expect(readSticky).not.toHaveBeenCalled();
		store.cleanup();
	});

	it("discards a queued member refresh when the store is disposed", async () => {
		const { client, room } = setup();
		const store = createSummariesStore(client);
		store.init();
		room.currentState.setStateEvents([
			new MatrixEvent({
				event_id: "$leave",
				room_id: ROOM,
				sender: USER,
				type: EventType.RoomMember,
				state_key: USER,
				origin_server_ts: NOW,
				content: { membership: "leave" },
			}),
		]);
		store.cleanup();
		const readSticky = vi.spyOn(room, "_unstable_getStickyEvents");
		await Promise.resolve();
		expect(readSticky).not.toHaveBeenCalled();
	});

	it("detaches sticky listeners when a room is forgotten and when the store is disposed", () => {
		const { client, room } = setup();
		const baseline = room.listenerCount(RoomStickyEventsEvent.Update);
		const store = createSummariesStore(client);
		store.init();
		expect(room.listenerCount(RoomStickyEventsEvent.Update)).toBe(baseline + 1);
		client.store.removeRoom(ROOM);
		client.emit(ClientEvent.DeleteRoom, ROOM);
		expect(room.listenerCount(RoomStickyEventsEvent.Update)).toBe(baseline);
		client.store.storeRoom(room);
		client.emit(ClientEvent.Room, room);
		store.cleanup();
		expect(room.listenerCount(RoomStickyEventsEvent.Update)).toBe(baseline);
	});

	it("feeds hashed identities and expiry through the real SDK session listeners", async () => {
		const { client, room } = setup();
		const session = client.matrixRTC.getRoomSession(room);
		const changed = vi.fn();
		session.on(MatrixRTCSessionEvent.MembershipsChanged, changed);
		try {
			room._unstable_addStickyEvents([sticky()]);
			await vi.waitFor(() => expect(session.memberships).toHaveLength(1));
			expect(session.memberships[0]?.rtcBackendIdentity).toBe(IDENTITY);
			expect(session.memberships[0]?.userId).toBe(USER);
			expect(changed).toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(60_050);
			await vi.waitFor(() => expect(session.memberships).toHaveLength(0));
		} finally {
			await session.stop();
		}
	});
});
