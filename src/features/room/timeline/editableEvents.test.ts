import type { EventStatus } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { findLastEditableEvent, isEditableEvent } from "./editableEvents";
import type { TimelineEvent } from "./timelineTypes";

const ME = "@me:example.com";

function ev(
	partial: Pick<TimelineEvent, "senderId" | "msgtype"> & {
		eventId?: string;
		// null = fully sent (the default); a non-null status is an in-flight echo.
		status?: EventStatus | null;
		// A truthy stateNotice marks a membership/state row (not a message).
		stateNotice?: boolean;
	},
): TimelineEvent {
	return {
		eventId: partial.eventId ?? "$e:example.com",
		senderId: partial.senderId,
		msgtype: partial.msgtype,
		status: partial.status ?? null,
		stateNotice: partial.stateNotice ? {} : null,
	} as unknown as TimelineEvent;
}

describe("isEditableEvent", () => {
	it("accepts an own, sent m.text", () => {
		expect(isEditableEvent(ev({ senderId: ME, msgtype: "m.text" }), ME)).toBe(
			true,
		);
	});

	it("rejects another user's message", () => {
		expect(
			isEditableEvent(
				ev({ senderId: "@other:example.com", msgtype: "m.text" }),
				ME,
			),
		).toBe(false);
	});

	it("rejects own non-text messages", () => {
		expect(isEditableEvent(ev({ senderId: ME, msgtype: "m.image" }), ME)).toBe(
			false,
		);
	});

	it("rejects an in-flight local echo (non-null send status)", () => {
		expect(
			isEditableEvent(
				ev({
					senderId: ME,
					msgtype: "m.text",
					status: "sending" as EventStatus,
				}),
				ME,
			),
		).toBe(false);
	});
});

describe("findLastEditableEvent", () => {
	it("returns null for an empty timeline", () => {
		expect(findLastEditableEvent([], ME)).toBeNull();
	});

	it("returns the user's most recent own m.text message", () => {
		const events = [
			ev({ senderId: ME, msgtype: "m.text", eventId: "$1" }),
			ev({ senderId: "@other:example.com", msgtype: "m.text", eventId: "$2" }),
			ev({ senderId: ME, msgtype: "m.text", eventId: "$3" }),
		];
		expect(findLastEditableEvent(events, ME)?.eventId).toBe("$3");
	});

	it("skips over other users' later messages to the user's own last message", () => {
		// The user's last message is $1; others have posted since. Edit-my-last
		// still resolves $1 (walking past other people's messages is fine).
		const events = [
			ev({ senderId: ME, msgtype: "m.text", eventId: "$1" }),
			ev({ senderId: "@other:example.com", msgtype: "m.text", eventId: "$2" }),
			ev({ senderId: "@other:example.com", msgtype: "m.text", eventId: "$3" }),
		];
		expect(findLastEditableEvent(events, ME)?.eventId).toBe("$1");
	});

	it("no-ops when the user's own last message is non-text (does not hunt back)", () => {
		// Latest own message is an image; editing the older $1 text would be the
		// wrong message, so the shortcut must no-op.
		const events = [
			ev({ senderId: ME, msgtype: "m.text", eventId: "$1" }),
			ev({ senderId: ME, msgtype: "m.image", eventId: "$2" }),
		];
		expect(findLastEditableEvent(events, ME)).toBeNull();
	});

	it("skips the user's own state notice to reach their last message", () => {
		// User sends a text message, then changes their display name (an own
		// membership/state row becomes the tail). Up should still edit the text.
		const events = [
			ev({ senderId: ME, msgtype: "m.text", eventId: "$msg" }),
			ev({
				senderId: ME,
				msgtype: "",
				eventId: "$namechange",
				stateNotice: true,
			}),
		];
		expect(findLastEditableEvent(events, ME)?.eventId).toBe("$msg");
	});

	it("no-ops when the user's own last message is an in-flight echo", () => {
		// Pressing Up right after Enter must not jump back to the older $sent
		// message while the just-sent one is still a local echo.
		const events = [
			ev({ senderId: ME, msgtype: "m.text", eventId: "$sent" }),
			ev({
				senderId: ME,
				msgtype: "m.text",
				eventId: "$echo",
				status: "sending" as EventStatus,
			}),
		];
		expect(findLastEditableEvent(events, ME)).toBeNull();
	});

	it("returns null when the user has no message at all", () => {
		const events = [
			ev({ senderId: "@other:example.com", msgtype: "m.text" }),
			ev({ senderId: "@other:example.com", msgtype: "m.image" }),
		];
		expect(findLastEditableEvent(events, ME)).toBeNull();
	});
});
