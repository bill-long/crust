import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../test/mockClient";
import {
	callMembershipExpiresAt,
	createSummariesStore,
	getNextCallExpiry,
	isCallActive,
} from "./summaries";
import { getSpaces } from "./summaries-selectors";

const CALL_TYPE = "org.matrix.msc3401.call.member";
const NOW = 1_780_000_000_000;
const HOUR = 60 * 60 * 1000;

function modernMembership(opts: {
	createdTs: number;
	expires?: number;
	deviceId?: string;
}) {
	return {
		application: "m.call",
		call_id: "",
		created_ts: opts.createdTs,
		device_id: opts.deviceId ?? "DEV",
		expires: opts.expires,
		scope: "m.room",
		focus_active: { focus_selection: "oldest_membership", type: "livekit" },
		foci_preferred: [],
	};
}

describe("callMembershipExpiresAt", () => {
	const makeEv = (content: Record<string, unknown>, ts = NOW): MatrixEvent =>
		({ getContent: () => content, getTs: () => ts }) as unknown as MatrixEvent;

	it("returns created_ts + expires for a valid membership", () => {
		expect(
			callMembershipExpiresAt(
				makeEv(modernMembership({ createdTs: 1000, expires: 5000 })),
			),
		).toBe(6000);
	});

	it("defaults to the 4h expiry when expires is absent", () => {
		expect(
			callMembershipExpiresAt(makeEv(modernMembership({ createdTs: 1000 }))),
		).toBe(1000 + 4 * HOUR);
	});

	it("falls back to the event ts when created_ts is absent", () => {
		const content = modernMembership({ createdTs: 0, expires: 5000 }) as Record<
			string,
			unknown
		>;
		delete content.created_ts;
		expect(callMembershipExpiresAt(makeEv(content, 2000))).toBe(7000);
	});

	it("returns a numeric NaN (not a string) for a non-numeric expires", () => {
		const content = modernMembership({ createdTs: 1000 }) as Record<
			string,
			unknown
		>;
		content.expires = "garbage";
		const result = callMembershipExpiresAt(makeEv(content));
		expect(typeof result).toBe("number");
		expect(Number.isNaN(result as number)).toBe(true);
	});

	it("returns null for empty / legacy / non-membership shapes", () => {
		expect(callMembershipExpiresAt(makeEv({}))).toBeNull();
		expect(callMembershipExpiresAt(makeEv({ "m.calls": [{}] }))).toBeNull();
	});
});

describe("isCallActive", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns false when no call-member events exist", () => {
		const room = createMockRoom("!r:x");
		expect(isCallActive(room as unknown as Room)).toBe(false);
	});

	it("ignores empty (tombstone) content", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__setStateEvent(CALL_TYPE, "_@a:x_DEV_m.call", {}, { sender: "@a:x" });
		expect(isCallActive(room as unknown as Room)).toBe(false);
	});

	it("returns true for a live modern per-device membership", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__setStateEvent(
			CALL_TYPE,
			"_@a:x_DEV_m.call",
			modernMembership({ createdTs: NOW - HOUR, expires: 4 * HOUR }),
			{ sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(true);
	});

	it("returns false for an expired modern per-device membership", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__setStateEvent(
			CALL_TYPE,
			"_@a:x_DEV_m.call",
			modernMembership({ createdTs: NOW - 10 * HOUR, expires: 4 * HOUR }),
			{ sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(false);
	});

	it("uses the 4h default expiry when `expires` is omitted", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__setStateEvent(
			CALL_TYPE,
			"_@a:x_DEV_m.call",
			modernMembership({ createdTs: NOW - 5 * HOUR }),
			{ sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(false);

		room.__setStateEvent(
			CALL_TYPE,
			"_@a:x_DEV_m.call",
			modernMembership({ createdTs: NOW - 1 * HOUR }),
			{ sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(true);
	});

	it("ignores the deprecated `memberships:[...]` array shape", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__setStateEvent(
			CALL_TYPE,
			"@a:x",
			{
				memberships: [
					{
						application: "m.call",
						call_id: "",
						device_id: "DEV",
						expires_ts: NOW + HOUR,
					},
				],
			},
			{ sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(false);
	});

	it("ignores live memberships whose sender has left the room", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a", membership: "leave" });
		room.__setStateEvent(
			CALL_TYPE,
			"_@a:x_DEV_m.call",
			modernMembership({ createdTs: NOW - HOUR, expires: 4 * HOUR }),
			{ sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(false);
	});

	it("ignores malformed modern memberships missing required fields", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		// Missing device_id / call_id / focus_active.type.
		room.__setStateEvent(
			CALL_TYPE,
			"_@a:x_DEV_m.call",
			{
				application: "m.call",
				created_ts: NOW - HOUR,
				expires: 4 * HOUR,
				scope: "m.room",
			},
			{ sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(false);
	});

	it("ignores memberships with malformed foci_preferred", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__setStateEvent(
			CALL_TYPE,
			"_@a:x_DEV_m.call",
			{
				...modernMembership({ createdTs: NOW - HOUR, expires: 4 * HOUR }),
				foci_preferred: "not-an-array",
			},
			{ sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(false);
	});

	it("ignores memberships with malformed foci_preferred array elements", () => {
		const cases: unknown[] = [
			[null],
			["string-element"],
			[{ type: 1 }],
			[{}],
			[{ type: "livekit" }, null],
		];
		for (const foci of cases) {
			const room = createMockRoom("!r:x");
			room.__addMember({ userId: "@a:x", name: "a" });
			room.__setStateEvent(
				CALL_TYPE,
				"_@a:x_DEV_m.call",
				{
					...modernMembership({ createdTs: NOW - HOUR, expires: 4 * HOUR }),
					foci_preferred: foci,
				},
				{ sender: "@a:x" },
			);
			expect(isCallActive(room as unknown as Room)).toBe(false);
		}
	});

	it("accepts memberships with valid foci_preferred array elements", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__setStateEvent(
			CALL_TYPE,
			"_@a:x_DEV_m.call",
			{
				...modernMembership({ createdTs: NOW - HOUR, expires: 4 * HOUR }),
				foci_preferred: [{ type: "livekit", livekit_service_url: "https://x" }],
			},
			{ sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(true);
	});

	it("ignores memberships with non-number created_ts", () => {
		for (const bad of [{ created_ts: "not-a-number" }, { created_ts: true }]) {
			const room = createMockRoom("!r:x");
			room.__addMember({ userId: "@a:x", name: "a" });
			room.__setStateEvent(
				CALL_TYPE,
				"_@a:x_DEV_m.call",
				{
					...modernMembership({ createdTs: NOW - HOUR, expires: 4 * HOUR }),
					...bad,
				},
				{ sender: "@a:x" },
			);
			expect(isCallActive(room as unknown as Room)).toBe(false);
		}
	});

	it("ignores memberships with non-string scope or m.call.intent", () => {
		for (const bad of [
			{ scope: 123 },
			{ scope: null },
			{ "m.call.intent": 1 },
			{ "m.call.intent": {} },
		]) {
			const room = createMockRoom("!r:x");
			room.__addMember({ userId: "@a:x", name: "a" });
			room.__setStateEvent(
				CALL_TYPE,
				"_@a:x_DEV_m.call",
				{
					...modernMembership({ createdTs: NOW - HOUR, expires: 4 * HOUR }),
					...bad,
				},
				{ sender: "@a:x" },
			);
			expect(isCallActive(room as unknown as Room)).toBe(false);
		}
	});

	it("treats non-numeric content.expires as not-expired (matches SDK NaN semantics)", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__setStateEvent(
			CALL_TYPE,
			"_@a:x_DEV_m.call",
			{
				...modernMembership({ createdTs: NOW - HOUR }),
				expires: "garbage",
			},
			{ sender: "@a:x" },
		);
		// The SDK does not type-check `expires`. A non-numeric value flows
		// through arithmetic and the resulting `<= now` comparison coerces
		// to NaN, which is always false — so the membership is treated as
		// not-expired (live), regardless of how much wall-clock time has
		// passed. We mirror that behavior here.
		expect(isCallActive(room as unknown as Room)).toBe(true);
	});

	it("also treats non-numeric content.expires as not-expired when created_ts is ancient", () => {
		// Stronger assertion: prove it's NOT just "default 4h from 1h ago".
		// With createdTs 10 years ago, a real 4h default would be expired —
		// but NaN comparison stays false, so we still get `true`.
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		const TEN_YEARS_MS = 10 * 365 * 24 * HOUR;
		room.__setStateEvent(
			CALL_TYPE,
			"_@a:x_DEV_m.call",
			{
				...modernMembership({ createdTs: NOW - TEN_YEARS_MS }),
				expires: "garbage",
			},
			{ sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(true);
	});

	it("ignores memberships for non-default call slots (call_id not '' or 'ROOM')", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__setStateEvent(
			CALL_TYPE,
			"_@a:x_DEV_m.call",
			{
				...modernMembership({ createdTs: NOW - HOUR, expires: 4 * HOUR }),
				call_id: "breakout-1",
			},
			{ sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(false);
	});

	it("accepts memberships with call_id 'ROOM' (new default slot id)", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__setStateEvent(
			CALL_TYPE,
			"_@a:x_DEV_m.call",
			{
				...modernMembership({ createdTs: NOW - HOUR, expires: 4 * HOUR }),
				call_id: "ROOM",
			},
			{ sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(true);
	});

	it("ignores events with no sender", () => {
		const room = createMockRoom("!r:x");
		room.__setStateEvent(
			CALL_TYPE,
			"_anon_DEV_m.call",
			modernMembership({ createdTs: NOW - HOUR, expires: 4 * HOUR }),
			// sender omitted → mock returns null
		);
		expect(isCallActive(room as unknown as Room)).toBe(false);
	});

	it("falls back to ev.getTs() when content.created_ts is omitted", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__setStateEvent(
			CALL_TYPE,
			"_@a:x_DEV_m.call",
			{
				application: "m.call",
				call_id: "",
				device_id: "DEV",
				scope: "m.room",
				focus_active: { type: "livekit" },
				expires: 4 * HOUR,
			},
			{ ts: NOW - HOUR, sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(true);
	});

	it("treats events with origin ts in the distant past as expired when created_ts is omitted", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__setStateEvent(
			CALL_TYPE,
			"_@a:x_DEV_m.call",
			{
				application: "m.call",
				call_id: "",
				device_id: "DEV",
				scope: "m.room",
				focus_active: { type: "livekit" },
				expires: 4 * HOUR,
			},
			{ ts: NOW - 10 * HOUR, sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(false);
	});

	it("returns true when at least one membership among many is live and joined", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@stale:x", name: "stale" });
		room.__addMember({ userId: "@live:x", name: "live" });
		room.__setStateEvent(
			CALL_TYPE,
			"_@stale:x_D1_m.call",
			modernMembership({
				createdTs: NOW - 10 * HOUR,
				expires: 4 * HOUR,
				deviceId: "D1",
			}),
			{ sender: "@stale:x" },
		);
		room.__setStateEvent(
			CALL_TYPE,
			"_@live:x_D2_m.call",
			modernMembership({
				createdTs: NOW - HOUR,
				expires: 4 * HOUR,
				deviceId: "D2",
			}),
			{ sender: "@live:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(true);
	});
});

describe("getNextCallExpiry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns null when no live memberships exist", () => {
		const room = createMockRoom("!r:x");
		expect(getNextCallExpiry(room as unknown as Room, NOW)).toBeNull();
	});

	it("returns the absolute expiry of a single live membership", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__setStateEvent(
			"org.matrix.msc3401.call.member",
			"_@a:x_DEV_m.call",
			modernMembership({ createdTs: NOW - HOUR, expires: 4 * HOUR }),
			{ sender: "@a:x" },
		);
		expect(getNextCallExpiry(room as unknown as Room, NOW)).toBe(
			NOW - HOUR + 4 * HOUR,
		);
	});

	it("returns the minimum expiry across multiple live memberships", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__addMember({ userId: "@b:x", name: "b" });
		room.__setStateEvent(
			"org.matrix.msc3401.call.member",
			"_@a:x_D1_m.call",
			modernMembership({
				createdTs: NOW - 30 * 60 * 1000,
				expires: 4 * HOUR,
				deviceId: "D1",
			}),
			{ sender: "@a:x" },
		);
		room.__setStateEvent(
			"org.matrix.msc3401.call.member",
			"_@b:x_D2_m.call",
			modernMembership({
				createdTs: NOW - HOUR,
				expires: 4 * HOUR,
				deviceId: "D2",
			}),
			{ sender: "@b:x" },
		);
		expect(getNextCallExpiry(room as unknown as Room, NOW)).toBe(
			NOW - HOUR + 4 * HOUR,
		);
	});

	it("returns null when the only live memberships have non-finite expiry", () => {
		const room = createMockRoom("!r:x");
		room.__addMember({ userId: "@a:x", name: "a" });
		const content = modernMembership({ createdTs: NOW - HOUR }) as Record<
			string,
			unknown
		>;
		content.expires = "garbage" as unknown as number;
		room.__setStateEvent(
			"org.matrix.msc3401.call.member",
			"_@a:x_DEV_m.call",
			content,
			{ sender: "@a:x" },
		);
		expect(isCallActive(room as unknown as Room)).toBe(true);
		expect(getNextCallExpiry(room as unknown as Room, NOW)).toBeNull();
	});
});

describe("createSummariesStore call expiry timer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function stubRoomForStore(room: ReturnType<typeof createMockRoom>) {
		const r = room as unknown as Record<string, unknown>;
		r.isCallRoom = () => false;
		r.isElementVideoRoom = () => false;
		r.getAvatarUrl = () => null;
		r.getUnreadNotificationCount = () => 0;
		r.getMyMembership = () => "join";
		r.hasEncryptionStateEvent = () => false;
		return room;
	}

	function makeRoomWithActiveCall(roomId: string, expiresAt: number) {
		const room = stubRoomForStore(createMockRoom(roomId));
		room.__addMember({ userId: "@a:x", name: "a" });
		const createdTs = NOW - 60_000;
		const expires = expiresAt - createdTs;
		room.__setStateEvent(
			"org.matrix.msc3401.call.member",
			"_@a:x_DEV_m.call",
			modernMembership({ createdTs, expires }),
			{ sender: "@a:x" },
		);
		return room;
	}

	it("flips callActive to false when the earliest expiry elapses", () => {
		const expiresAt = NOW + 60_000; // 60s from now
		const room = makeRoomWithActiveCall("!r:x", expiresAt);
		const rooms = new Map([[room.roomId, room]]);
		const client = createMockClient(rooms);
		const store = createSummariesStore(client as unknown as MatrixClient);
		store.init();

		expect(store.summaries[room.roomId].callActive).toBe(true);

		vi.advanceTimersByTime(60_000 + 100);

		expect(store.summaries[room.roomId].callActive).toBe(false);

		store.cleanup();
	});

	it("does not schedule a timer when the only memberships have non-finite expiry", () => {
		const room = stubRoomForStore(createMockRoom("!r:x"));
		room.__addMember({ userId: "@a:x", name: "a" });
		const content = modernMembership({ createdTs: NOW - HOUR }) as Record<
			string,
			unknown
		>;
		content.expires = "garbage" as unknown as number;
		room.__setStateEvent(
			"org.matrix.msc3401.call.member",
			"_@a:x_DEV_m.call",
			content,
			{ sender: "@a:x" },
		);
		const rooms = new Map([[room.roomId, room]]);
		const client = createMockClient(rooms);
		const store = createSummariesStore(client as unknown as MatrixClient);
		store.init();

		expect(store.summaries[room.roomId].callActive).toBe(true);
		expect(vi.getTimerCount()).toBe(0);

		store.cleanup();
	});

	it("cleanup clears any pending expiry timers", () => {
		const expiresAt = NOW + 60_000;
		const room = makeRoomWithActiveCall("!r:x", expiresAt);
		const rooms = new Map([[room.roomId, room]]);
		const client = createMockClient(rooms);
		const store = createSummariesStore(client as unknown as MatrixClient);
		store.init();

		expect(vi.getTimerCount()).toBeGreaterThan(0);

		store.cleanup();

		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears the timer when the room is deleted", () => {
		const expiresAt = NOW + 60_000;
		const room = makeRoomWithActiveCall("!r:x", expiresAt);
		const rooms = new Map([[room.roomId, room]]);
		const client = createMockClient(rooms);
		const store = createSummariesStore(client as unknown as MatrixClient);
		store.init();

		expect(vi.getTimerCount()).toBe(1);

		client.__emit("deleteRoom", room.roomId);

		expect(vi.getTimerCount()).toBe(0);
		expect(store.summaries[room.roomId]).toBeUndefined();

		store.cleanup();
	});

	it("recomputes callActive when a live event reveals server clock skew", () => {
		// Membership whose server-clock expiry is 1h30m before NOW.
		// With offset 0 (default), the client thinks it's expired.
		// But the server clock is actually 2h *behind* the client clock,
		// so on server time the membership still has 30 minutes to live.
		const createdTs = NOW - 2 * HOUR - 30 * 60_000;
		const expires = HOUR;
		const room = stubRoomForStore(createMockRoom("!r:x"));
		room.__addMember({ userId: "@a:x", name: "a" });
		room.__setStateEvent(
			"org.matrix.msc3401.call.member",
			"_@a:x_DEV_m.call",
			modernMembership({ createdTs, expires }),
			{ sender: "@a:x" },
		);
		const rooms = new Map([[room.roomId, room]]);
		const client = createMockClient(rooms);
		const store = createSummariesStore(client as unknown as MatrixClient);
		store.init();

		// Without any server-time sample yet, the client clock wins and
		// the membership is treated as expired.
		expect(store.summaries[room.roomId].callActive).toBe(false);

		// Live event whose origin_server_ts implies server time is 2h
		// behind the client clock. `unsigned.age = 0` => localTimestamp
		// equals Date.now() => offset = ts - localTimestamp = -2h.
		const originServerTs = NOW - 2 * HOUR;
		const liveEvent = {
			event: { unsigned: { age: 0 } },
			getTs: () => originServerTs,
			localTimestamp: NOW,
			getContent: () => ({}),
			getType: () => "m.room.message",
			getSender: () => "@a:x",
		} as unknown as MatrixEvent;
		client.__emit("Room.timeline", liveEvent, room, undefined, false, {
			liveEvent: true,
		});

		// callActive should flip to true now that the offset-corrected
		// "now" is before the membership expiry.
		expect(store.summaries[room.roomId].callActive).toBe(true);

		store.cleanup();
	});
});

describe("createSummariesStore optimisticallyMarkJoined", () => {
	function makeStore() {
		const rooms = new Map<string, ReturnType<typeof createMockRoom>>();
		const client = createMockClient(rooms);
		const store = createSummariesStore(client as unknown as MatrixClient);
		return store;
	}

	it("creates a stub summary entry when none exists", () => {
		const store = makeStore();
		store.optimisticallyMarkJoined("!new:x", {
			name: "General",
			avatarUrl: "https://example.com/a.png",
		});

		const s = store.summaries["!new:x"];
		expect(s).toBeDefined();
		expect(s.roomId).toBe("!new:x");
		expect(s.name).toBe("General");
		expect(s.avatarUrl).toBe("https://example.com/a.png");
		expect(s.membership).toBe("join");
		expect(s.isSpace).toBe(false);
		expect(s.kind).toBe("text");
		expect(s.unreadCount).toBe(0);
		expect(s.highlightCount).toBe(0);
		expect(s.callActive).toBe(false);
		expect(s.children).toEqual([]);
		expect(s.lastMessage).toBeNull();

		store.cleanup();
	});

	it("flips an existing non-join summary to membership='join' without clobbering other fields", () => {
		const store = makeStore();
		store.setSummaries("!r:x", {
			roomId: "!r:x",
			name: "Existing name",
			avatarUrl: "existing.png",
			lastMessage: { body: "hi", sender: "@a:x", timestamp: 1000 },
			unreadCount: 3,
			highlightCount: 1,
			membership: "leave",
			isEncrypted: true,
			isDirect: false,
			isSpace: false,
			kind: "text",
			callActive: false,
			children: [],
		});

		store.optimisticallyMarkJoined("!r:x", {
			name: "Hierarchy name",
			avatarUrl: "hierarchy.png",
		});

		const s = store.summaries["!r:x"];
		expect(s.membership).toBe("join");
		// Existing authoritative fields are preserved — hierarchy is only
		// a fallback when there's no summary yet.
		expect(s.name).toBe("Existing name");
		expect(s.avatarUrl).toBe("existing.png");
		expect(s.unreadCount).toBe(3);
		expect(s.isEncrypted).toBe(true);
		expect(s.lastMessage).toEqual({
			body: "hi",
			sender: "@a:x",
			timestamp: 1000,
		});

		store.cleanup();
	});

	it("is a no-op when the room is already marked as joined", () => {
		const store = makeStore();
		store.setSummaries("!r:x", {
			roomId: "!r:x",
			name: "Real name",
			avatarUrl: null,
			lastMessage: null,
			unreadCount: 0,
			highlightCount: 0,
			membership: "join",
			isEncrypted: false,
			isDirect: false,
			isSpace: false,
			kind: "text",
			callActive: false,
			children: [],
		});

		store.optimisticallyMarkJoined("!r:x", {
			name: "Should-not-overwrite",
			avatarUrl: "should-not-overwrite.png",
		});

		expect(store.summaries["!r:x"].name).toBe("Real name");
		expect(store.summaries["!r:x"].avatarUrl).toBeNull();

		store.cleanup();
	});

	it("creates a space stub when isSpace=true is passed", () => {
		const store = makeStore();
		store.optimisticallyMarkJoined("!space:x", {
			name: "My Space",
			avatarUrl: null,
			isSpace: true,
		});

		expect(store.summaries["!space:x"].isSpace).toBe(true);

		store.cleanup();
	});

	it("promotes an existing non-space entry to isSpace=true when isSpace=true is passed", () => {
		const store = makeStore();
		store.setSummaries("!r:x", {
			roomId: "!r:x",
			name: "Stale name",
			avatarUrl: null,
			lastMessage: null,
			unreadCount: 0,
			highlightCount: 0,
			membership: "leave",
			isEncrypted: false,
			isDirect: false,
			isSpace: false,
			kind: "text",
			callActive: false,
			children: [],
		});

		store.optimisticallyMarkJoined("!r:x", {
			name: "ignored",
			avatarUrl: null,
			isSpace: true,
		});

		expect(store.summaries["!r:x"].isSpace).toBe(true);
		expect(store.summaries["!r:x"].membership).toBe("join");

		store.cleanup();
	});

	it("does not flip isSpace=true to false when isSpace is omitted or false", () => {
		const store = makeStore();
		store.setSummaries("!s:x", {
			roomId: "!s:x",
			name: "A Space",
			avatarUrl: null,
			lastMessage: null,
			unreadCount: 0,
			highlightCount: 0,
			membership: "leave",
			isEncrypted: false,
			isDirect: false,
			isSpace: true,
			kind: "text",
			callActive: false,
			children: [],
		});

		store.optimisticallyMarkJoined("!s:x", {
			name: "ignored",
			avatarUrl: null,
		});

		expect(store.summaries["!s:x"].isSpace).toBe(true);

		store.cleanup();
	});
});

describe("createSummariesStore optimisticallyMarkLeft", () => {
	function makeStore() {
		const rooms = new Map<string, ReturnType<typeof createMockRoom>>();
		const client = createMockClient(rooms);
		const store = createSummariesStore(client as unknown as MatrixClient);
		return store;
	}

	function joinedEntry(roomId: string, isSpace = false) {
		return {
			roomId,
			name: "Room",
			avatarUrl: null,
			lastMessage: null,
			unreadCount: 0,
			highlightCount: 0,
			membership: "join",
			isEncrypted: false,
			isDirect: false,
			isSpace,
			kind: "text" as const,
			callActive: false,
			children: [],
		};
	}

	it("flips a joined entry to membership='leave' without clobbering other fields", () => {
		const store = makeStore();
		store.setSummaries("!r:x", {
			...joinedEntry("!r:x"),
			name: "Keep me",
			avatarUrl: "keep.png",
			unreadCount: 5,
		});

		store.optimisticallyMarkLeft("!r:x");

		const s = store.summaries["!r:x"];
		expect(s.membership).toBe("leave");
		expect(s.name).toBe("Keep me");
		expect(s.avatarUrl).toBe("keep.png");
		expect(s.unreadCount).toBe(5);

		store.cleanup();
	});

	it("is a no-op when the entry does not exist", () => {
		const store = makeStore();
		store.optimisticallyMarkLeft("!missing:x");
		expect(store.summaries["!missing:x"]).toBeUndefined();
		store.cleanup();
	});

	it("is a no-op when the entry is already 'leave'", () => {
		const store = makeStore();
		store.setSummaries("!r:x", {
			...joinedEntry("!r:x"),
			membership: "leave",
		});
		store.optimisticallyMarkLeft("!r:x");
		expect(store.summaries["!r:x"].membership).toBe("leave");
		store.cleanup();
	});

	it("hides a left space from getSpaces", () => {
		const store = makeStore();
		store.setSummaries("!space:x", joinedEntry("!space:x", true));
		expect(getSpaces(store.summaries).map((s) => s.roomId)).toContain(
			"!space:x",
		);

		store.optimisticallyMarkLeft("!space:x");
		expect(getSpaces(store.summaries).map((s) => s.roomId)).not.toContain(
			"!space:x",
		);

		store.cleanup();
	});
});
