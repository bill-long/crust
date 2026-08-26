import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "./timelineTypes";
import { firstUnreadIndex } from "./unreadMarker";

const ME = "@me:example.com";
const THEM = "@them:example.com";

function row(
	eventId: string,
	senderId: string = THEM,
	stateNotice: TimelineEvent["stateNotice"] = null,
): TimelineEvent {
	return { eventId, senderId, stateNotice } as TimelineEvent;
}

describe("firstUnreadIndex", () => {
	it("marks the row after the read receipt", () => {
		const events = [row("$a"), row("$b"), row("$c")];
		expect(firstUnreadIndex(events, "$a", ME)).toBe(1);
	});

	it("has nothing to mark when the receipt is at the newest row", () => {
		const events = [row("$a"), row("$b")];
		expect(firstUnreadIndex(events, "$b", ME)).toBe(-1);
	});

	it("has nothing to mark before anything has been read", () => {
		expect(firstUnreadIndex([row("$a")], null, ME)).toBe(-1);
	});

	it("has nothing to mark when the receipt is outside the window", () => {
		// Paginated away from the boundary: the divider cannot be placed, and
		// claiming the top of the window is unread would be a lie.
		const events = [row("$b"), row("$c")];
		expect(firstUnreadIndex(events, "$older", ME)).toBe(-1);
	});

	it("skips our own messages - nothing we sent is news to us", () => {
		const events = [row("$a"), row("$b", ME), row("$c", ME), row("$d")];
		expect(firstUnreadIndex(events, "$a", ME)).toBe(3);
	});

	it("skips state notices - a join is not what the user came back for", () => {
		const events = [
			row("$a"),
			row("$b", THEM, { text: "them joined", icon: "join" }),
			row("$c"),
		];
		expect(firstUnreadIndex(events, "$a", ME)).toBe(2);
	});

	it("has nothing to mark when only our own sends follow the receipt", () => {
		const events = [row("$a"), row("$b", ME)];
		expect(firstUnreadIndex(events, "$a", ME)).toBe(-1);
	});

	it("has nothing to mark when only notices follow the receipt", () => {
		const events = [
			row("$a"),
			row("$b", THEM, { text: "them left", icon: "leave" }),
		];
		expect(firstUnreadIndex(events, "$a", ME)).toBe(-1);
	});
});
