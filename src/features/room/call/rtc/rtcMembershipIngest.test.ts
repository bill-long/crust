import { MatrixRTCSession } from "matrix-js-sdk/lib/matrixrtc/MatrixRTCSession";
import { describe, expect, it } from "vitest";
import { requiredAt } from "./testAssertions";

/**
 * Locks the matrix-js-sdk behaviour Crust's identity resolution depends on
 * (#488): `MatrixRTCSession.sessionMembershipsForSlot` must ingest BOTH
 *
 *   - legacy `org.matrix.msc3401.call.member` state events, whose
 *     `rtcBackendIdentity` is the plain `userId:deviceId` pair, and
 *   - MSC4143 `org.matrix.msc4143.rtc.member` sticky events (MSC4354),
 *     whose `rtcBackendIdentity` is the MSC4195 hash
 *     `unpaddedBase64(sha256(canonicalJSON([user_id, device_id, member.id])))`
 *     - the value lk-jwt-service's new endpoint puts on the LiveKit wire.
 *
 * `useLivekitRoom.resolveIdentity` matches LiveKit `participant.identity`
 * against `rtcBackendIdentity` by string equality, so these are the exact
 * values that make a hashed Element Call peer resolve to a display name.
 * If an SDK upgrade changes either computation, this suite - not a raw
 * hash in a call overlay - is where it should surface.
 *
 * The fake room implements only the surface `sessionMembershipsForSlot`
 * touches: live-timeline state, the MSC4354 sticky store, and joined-member
 * checks.
 */

// The slot the default MatrixRTCSessionManager (client.matrixRTC) targets.
const SLOT = { application: "m.call", id: "ROOM" };

interface FakeEventSpec {
	id: string;
	type: string;
	sender: string;
	content: Record<string, unknown>;
	stateKey?: string;
	ts?: number;
}

// Shaped like the SDK's `LimitedEvent` pick of MatrixEvent (plus
// `getStateKey` for the sticky/state dedupe).
function fakeEvent(spec: FakeEventSpec) {
	return {
		getId: () => spec.id,
		getSender: () => spec.sender,
		getTs: () => spec.ts ?? Date.now(),
		getType: () => spec.type,
		getContent: () => spec.content,
		getStateKey: () => spec.stateKey,
	};
}

type FakeEvent = ReturnType<typeof fakeEvent>;

function fakeRoom(opts: {
	stateEvents?: FakeEvent[];
	stickyEvents?: FakeEvent[];
	joinedUsers: string[];
}) {
	const state = {
		getStateEvents: (type: string, stateKey?: string) => {
			// Two-arg form is only used for the (absent) RTC slot event.
			if (stateKey !== undefined) return null;
			return (opts.stateEvents ?? []).filter((e) => e.getType() === type);
		},
	};
	return {
		roomId: "!room:example.org",
		getLiveTimeline: () => ({ getState: () => state }),
		_unstable_getStickyEvents: () => opts.stickyEvents ?? [],
		hasMembershipState: (userId: string, membership: string) =>
			membership === "join" && opts.joinedUsers.includes(userId),
	};
}

const legacyMemberEvent = (over?: { sender?: string; deviceId?: string }) => {
	const sender = over?.sender ?? "@alice:example.org";
	const deviceId = over?.deviceId ?? "DEVA";
	return fakeEvent({
		id: `$legacy-${sender}`,
		type: "org.matrix.msc3401.call.member",
		sender,
		stateKey: `_${sender}_${deviceId}`,
		content: {
			application: "m.call",
			call_id: "",
			device_id: deviceId,
			scope: "m.room",
			focus_active: { type: "livekit", focus_selection: "oldest_membership" },
			foci_preferred: [
				{
					type: "livekit",
					livekit_service_url: "https://sfu.example.org",
					livekit_alias: "!room:example.org",
				},
			],
		},
	});
};

// Fixture triple + independently computed MSC4195 identity:
// unpaddedBase64(sha256('["@bob:example.org","DEVICE1","member-uuid-1"]'))
const RTC_MEMBER = {
	user_id: "@bob:example.org",
	device_id: "DEVICE1",
	id: "member-uuid-1",
};
const RTC_MEMBER_HASH = "c53v4dTzaQzS4pI/jouU5eCVHNPFYvNSUhL6V6MFrEA";

const rtcMemberEvent = (over?: { stickyKey?: string }) =>
	fakeEvent({
		id: "$rtc-bob",
		type: "org.matrix.msc4143.rtc.member",
		sender: RTC_MEMBER.user_id,
		content: {
			slot_id: "m.call#ROOM",
			member: RTC_MEMBER,
			application: { type: "m.call" },
			transports: {
				published: [
					{
						type: "livekit",
						livekit_service_url: "https://livekit-jwt.call.matrix.org",
						livekit_alias: "!room:example.org",
					},
				],
				can_subscribe: ["livekit"],
			},
			versions: [],
			msc4354_sticky_key: over?.stickyKey ?? `_${RTC_MEMBER.user_id}_DEVICE1`,
		},
	});

describe("MatrixRTCSession membership ingest (#488)", () => {
	it("ingests a legacy state membership with the userId:deviceId backend identity", async () => {
		const room = fakeRoom({
			stateEvents: [legacyMemberEvent()],
			joinedUsers: ["@alice:example.org"],
		});
		const memberships = await MatrixRTCSession.sessionMembershipsForSlot(
			room as never,
			SLOT,
		);
		expect(memberships).toHaveLength(1);
		expect(requiredAt(memberships, 0, "legacy membership").userId).toBe(
			"@alice:example.org",
		);
		expect(
			requiredAt(memberships, 0, "legacy membership").rtcBackendIdentity,
		).toBe("@alice:example.org:DEVA");
	});

	it("ingests an MSC4143 sticky membership with the MSC4195 hashed backend identity", async () => {
		const room = fakeRoom({
			stickyEvents: [rtcMemberEvent()],
			joinedUsers: [RTC_MEMBER.user_id],
		});
		const memberships = await MatrixRTCSession.sessionMembershipsForSlot(
			room as never,
			SLOT,
		);
		expect(memberships).toHaveLength(1);
		expect(requiredAt(memberships, 0, "sticky membership").userId).toBe(
			RTC_MEMBER.user_id,
		);
		expect(
			requiredAt(memberships, 0, "sticky membership").rtcBackendIdentity,
		).toBe(RTC_MEMBER_HASH);
	});

	it("surfaces legacy and MSC4143 memberships side by side", async () => {
		const room = fakeRoom({
			stateEvents: [legacyMemberEvent()],
			stickyEvents: [rtcMemberEvent()],
			joinedUsers: ["@alice:example.org", RTC_MEMBER.user_id],
		});
		const memberships = await MatrixRTCSession.sessionMembershipsForSlot(
			room as never,
			SLOT,
		);
		expect(memberships.map((m) => m.rtcBackendIdentity).sort()).toEqual(
			["@alice:example.org:DEVA", RTC_MEMBER_HASH].sort(),
		);
	});

	it("prefers the sticky event over a state event with the matching sticky key", async () => {
		// A peer that sends both formats (transition period) must not appear
		// twice: the SDK drops state events whose state_key matches a sticky
		// event's msc4354_sticky_key.
		const legacy = fakeEvent({
			id: "$legacy-bob",
			type: "org.matrix.msc3401.call.member",
			sender: RTC_MEMBER.user_id,
			stateKey: `_${RTC_MEMBER.user_id}_DEVICE1`,
			content: {
				application: "m.call",
				call_id: "",
				device_id: "DEVICE1",
				scope: "m.room",
				focus_active: { type: "livekit", focus_selection: "oldest_membership" },
				foci_preferred: [],
			},
		});
		const room = fakeRoom({
			stateEvents: [legacy],
			stickyEvents: [rtcMemberEvent()],
			joinedUsers: [RTC_MEMBER.user_id],
		});
		const memberships = await MatrixRTCSession.sessionMembershipsForSlot(
			room as never,
			SLOT,
		);
		expect(memberships).toHaveLength(1);
		expect(
			requiredAt(memberships, 0, "joined sticky membership").rtcBackendIdentity,
		).toBe(RTC_MEMBER_HASH);
	});
});
