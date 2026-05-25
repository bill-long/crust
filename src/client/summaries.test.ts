import type { Room } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRoom } from "../test/mockClient";
import { isCallActive } from "./summaries";

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

	it("falls back to default expiry when content.expires is non-numeric (matches SDK)", () => {
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
		// Default 4h expiry from 1h ago → still live.
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
