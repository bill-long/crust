import type { Room } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { getInviteDetails } from "./inviteDetails";

const MY_ID = "@me:example.com";
const INVITER_ID = "@amon:example.com";

interface FakeMemberEvent {
	getSender: () => string | undefined;
	getContent: () => Record<string, unknown>;
}

/** Minimal Room stand-in: my member (carrying the invite member event) plus
 *  an optional inviter member with a display name. */
function makeRoom(opts: {
	memberEvent?: FakeMemberEvent;
	inviterName?: string;
}): Room {
	return {
		getMember: (userId: string) => {
			if (userId === MY_ID) {
				return opts.memberEvent
					? { events: { member: opts.memberEvent } }
					: null;
			}
			if (userId === INVITER_ID) {
				return { name: opts.inviterName ?? userId, events: {} };
			}
			return null;
		},
	} as unknown as Room;
}

function makeMemberEvent(
	content: Record<string, unknown>,
	sender: string | undefined = INVITER_ID,
): FakeMemberEvent {
	return {
		getSender: () => sender,
		getContent: () => content,
	};
}

describe("getInviteDetails", () => {
	it("derives inviter id, display name, reason, and is_direct", () => {
		const room = makeRoom({
			memberEvent: makeMemberEvent({
				membership: "invite",
				is_direct: true,
				reason: "come chat",
			}),
			inviterName: "Amon",
		});
		expect(getInviteDetails(room, MY_ID)).toEqual({
			inviterId: INVITER_ID,
			inviterName: "Amon",
			reason: "come chat",
			isDirect: true,
		});
	});

	it("falls back to the inviter MXID when no profile is known", () => {
		const room = makeRoom({
			memberEvent: makeMemberEvent({ membership: "invite" }),
		});
		const details = getInviteDetails(room, MY_ID);
		expect(details.inviterName).toBe(INVITER_ID);
		expect(details.isDirect).toBe(false);
		expect(details.reason).toBeNull();
	});

	it("returns nulls when the invite member event is missing", () => {
		const room = makeRoom({});
		expect(getInviteDetails(room, MY_ID)).toEqual({
			inviterId: null,
			inviterName: null,
			reason: null,
			isDirect: false,
		});
	});

	it("treats a whitespace-only or non-string reason as absent", () => {
		const blank = makeRoom({
			memberEvent: makeMemberEvent({ reason: "   " }),
		});
		expect(getInviteDetails(blank, MY_ID).reason).toBeNull();
		const nonString = makeRoom({
			memberEvent: makeMemberEvent({ reason: 42 }),
		});
		expect(getInviteDetails(nonString, MY_ID).reason).toBeNull();
	});

	it("does not treat a truthy non-boolean is_direct as a DM", () => {
		const room = makeRoom({
			memberEvent: makeMemberEvent({ is_direct: "yes" }),
		});
		expect(getInviteDetails(room, MY_ID).isDirect).toBe(false);
	});
});
