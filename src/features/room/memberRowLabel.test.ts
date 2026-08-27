import { describe, expect, it } from "vitest";
import type { PresenceInfo } from "../../client/presence";
import { type MemberEntry, memberRowLabel } from "./useMemberList";

const entry = (over: Partial<MemberEntry> = {}): MemberEntry => ({
	userId: "@ann:x",
	displayName: "Ann",
	avatarUrl: null,
	powerLevel: 0,
	isTyping: false,
	...over,
});

const presence = (over: Partial<PresenceInfo> = {}): PresenceInfo => ({
	status: "unknown",
	statusMsg: null,
	...over,
});

describe("memberRowLabel", () => {
	it("names the person when nothing else is known", () => {
		// `unknown` makes no claim, so no state word appears - a grey dot
		// and the word "offline" would both assert something the server has
		// never told us.
		expect(memberRowLabel(entry(), presence())).toBe("View profile of Ann");
	});

	it("announces presence the server has told us about", () => {
		expect(memberRowLabel(entry(), presence({ status: "online" }))).toBe(
			"View profile of Ann, online",
		);
	});

	it("announces a status message", () => {
		expect(
			memberRowLabel(
				entry(),
				presence({ status: "idle", statusMsg: "In a meeting" }),
			),
		).toBe("View profile of Ann, idle, In a meeting");
	});

	it("announces typing in place of the status message", () => {
		// The row shows "typing" *instead of* the status, so a label that
		// carried both would make the two surfaces disagree in exactly the
		// case where they differ. Asserting the status is absent is what
		// makes this detect the regression.
		const label = memberRowLabel(
			entry({ isTyping: true }),
			presence({ status: "online", statusMsg: "In a meeting" }),
		);
		expect(label).toBe("View profile of Ann, online, typing");
		expect(label).not.toContain("In a meeting");
	});
});
