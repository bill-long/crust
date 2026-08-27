import type { MatrixEvent, Room } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import {
	buildLegacyCallNotice,
	computeLegacyCallSuppressions,
	isLegacyCallNoticeType,
} from "./legacyCallNotice";

const ME = "@me:example.com";
const ALICE = "@alice:example.com";

interface EventOptions {
	type?: string;
	sender?: string | null;
	callId?: string | null;
	eventId?: string | null;
	redacted?: boolean;
	invitee?: string;
}

function mkEvent(options: EventOptions = {}): MatrixEvent {
	const content: Record<string, unknown> = {};
	if (options.callId !== null) content.call_id = options.callId ?? "call-1";
	if (options.invitee !== undefined) content.invitee = options.invitee;
	return {
		getType: () => options.type ?? "m.call.invite",
		getSender: () => (options.sender === undefined ? ALICE : options.sender),
		getId: () => (options.eventId === undefined ? "$e1" : options.eventId),
		getContent: () => content,
		isRedacted: () => options.redacted ?? false,
	} as unknown as MatrixEvent;
}

/** A 1:1 room unless a test says otherwise - the DM case this feature is for. */
function mkRoom(joinedMembers = 2): Room {
	return {
		myUserId: ME,
		getMember: (userId: string) =>
			userId === ALICE ? { name: "Alice" } : null,
		getJoinedMemberCount: () => joinedMembers,
	} as unknown as Room;
}

const room = mkRoom();

describe("isLegacyCallNoticeType", () => {
	it("matches only the invite", () => {
		expect(isLegacyCallNoticeType("m.call.invite")).toBe(true);
	});

	it("leaves the rest of the signalling non-displayable", () => {
		// These are machinery for a call this client can never join; rendering
		// them would put several rows on screen for one missed call.
		for (const type of [
			"m.call.candidates",
			"m.call.answer",
			"m.call.select_answer",
			"m.call.negotiate",
			"m.call.hangup",
			"m.call.reject",
		]) {
			expect(isLegacyCallNoticeType(type)).toBe(false);
		}
	});
});

describe("buildLegacyCallNotice", () => {
	it("names the caller and the reason", () => {
		expect(buildLegacyCallNotice(mkEvent(), room)).toEqual({
			text: "Missed a call from Alice (unsupported call type)",
			icon: "info",
		});
	});

	it("falls back to the matrix ID for an unknown member", () => {
		const notice = buildLegacyCallNotice(
			mkEvent({ sender: "@ghost:example.com" }),
			room,
		);
		expect(notice?.text).toBe(
			"Missed a call from @ghost:example.com (unsupported call type)",
		);
	});

	it("does not tell the user they missed their own call", () => {
		// Placing a call from Element shows up here too; "missed a call from
		// Me" would be nonsense.
		const notice = buildLegacyCallNotice(mkEvent({ sender: ME }), room);
		expect(notice?.text).toBe(
			"You started a call from another session (unsupported call type)",
		);
	});

	it("does not claim a bystander missed an unaddressed call", () => {
		// MSC2746 makes `invitee` optional, so in a room of three an unnamed
		// invite would otherwise tell everyone they missed a call.
		const notice = buildLegacyCallNotice(mkEvent(), mkRoom(3));
		expect(notice?.text).toBe("Alice started a call (unsupported call type)");
	});

	it("does not claim a call placed to someone else was missed", () => {
		// MSC2746 invites can name their target. In a room of three, telling
		// the third person they missed a call they were never rung for is
		// simply false.
		const notice = buildLegacyCallNotice(
			mkEvent({ invitee: "@bob:example.com" }),
			room,
		);
		expect(notice?.text).toBe("Alice started a call (unsupported call type)");
	});

	it("still reads as missed when the invite names us", () => {
		const notice = buildLegacyCallNotice(mkEvent({ invitee: ME }), room);
		expect(notice?.text).toBe(
			"Missed a call from Alice (unsupported call type)",
		);
	});

	it("renders nothing for a redacted invite", () => {
		expect(buildLegacyCallNotice(mkEvent({ redacted: true }), room)).toBeNull();
	});

	it("renders nothing without a sender", () => {
		expect(buildLegacyCallNotice(mkEvent({ sender: null }), room)).toBeNull();
	});

	it("renders nothing without a call_id", () => {
		// The dedupe cannot key on it, so a row here could double up with a
		// sibling invite for the same call.
		expect(buildLegacyCallNotice(mkEvent({ callId: null }), room)).toBeNull();
	});

	it("renders nothing for other call signalling", () => {
		expect(
			buildLegacyCallNotice(mkEvent({ type: "m.call.hangup" }), room),
		).toBeNull();
	});
});

describe("computeLegacyCallSuppressions", () => {
	it("keeps one row per call when the caller retries", () => {
		const events = [
			mkEvent({ eventId: "$a", callId: "call-1" }),
			mkEvent({ eventId: "$b", callId: "call-1" }),
			mkEvent({ eventId: "$c", callId: "call-1" }),
		];
		expect([...computeLegacyCallSuppressions(events)]).toEqual(["$b", "$c"]);
	});

	it("keeps separate calls separate", () => {
		// Glare - both sides ringing at once - produces two distinct call_ids
		// and is genuinely two calls.
		const events = [
			mkEvent({ eventId: "$a", callId: "call-1" }),
			mkEvent({ eventId: "$b", callId: "call-2" }),
		];
		expect(computeLegacyCallSuppressions(events).size).toBe(0);
	});

	it("ignores the rest of the signalling", () => {
		const events = [
			mkEvent({ eventId: "$a", callId: "call-1" }),
			mkEvent({ eventId: "$b", type: "m.call.hangup", callId: "call-1" }),
			mkEvent({ eventId: "$c", type: "m.call.reject", callId: "call-1" }),
		];
		expect(computeLegacyCallSuppressions(events).size).toBe(0);
	});

	it("does not suppress on a call_id it could not read", () => {
		const events = [
			mkEvent({ eventId: "$a", callId: null }),
			mkEvent({ eventId: "$b", callId: null }),
		];
		expect(computeLegacyCallSuppressions(events).size).toBe(0);
	});
});
