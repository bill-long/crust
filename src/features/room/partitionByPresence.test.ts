import { describe, expect, it } from "vitest";
import type { PresenceStatus } from "../../client/presence";
import { requiredAt } from "./testAssertions";
import {
	type MemberEntry,
	type MemberGroup,
	partitionByPresence,
} from "./useMemberList";

const member = (userId: string, displayName = userId): MemberEntry =>
	({ userId, displayName }) as MemberEntry;

const statusMap =
	(map: Record<string, PresenceStatus>) =>
	(userId: string): PresenceStatus =>
		map[userId] ?? "unknown";

const groups = (spec: Record<string, string[]>): MemberGroup[] =>
	Object.entries(spec).map(([role, ids]) => ({
		role: role as MemberGroup["role"],
		// Not `ids.map(member)`: map passes the index as the second argument,
		// which would land in displayName.
		members: ids.map((id) => member(id)),
	}));

describe("partitionByPresence", () => {
	it("keeps role sections when nobody is known offline", () => {
		const out = partitionByPresence(
			groups({ Admin: ["@a"], Member: ["@b"] }),
			statusMap({ "@a": "online", "@b": "idle" }),
		);
		expect(out.map((g) => g.role)).toEqual(["Admin", "Member"]);
	});

	it("collects the offline into one section at the end", () => {
		// Discord's shape: who is around, then everyone else.
		const out = partitionByPresence(
			groups({ Admin: ["@a", "@b"], Member: ["@c", "@d"] }),
			statusMap({ "@a": "online", "@b": "offline", "@d": "offline" }),
		);
		expect(out.map((g) => g.role)).toEqual(["Admin", "Member", "Offline"]);
		expect(
			requiredAt(out, 0, "admin group").members.map((m) => m.userId),
		).toEqual(["@a"]);
		expect(
			requiredAt(out, 2, "offline group").members.map((m) => m.userId),
		).toEqual(["@b", "@d"]);
	});

	it("does not demote people the server never mentioned", () => {
		// unknown is most of a large room; treating it as offline would empty
		// the role sections on the strength of something we were never told.
		const out = partitionByPresence(
			groups({ Member: ["@a", "@b"] }),
			statusMap({}),
		);
		expect(out.map((g) => g.role)).toEqual(["Member"]);
		expect(requiredAt(out, 0, "member group").members).toHaveLength(2);
	});

	it("drops a role section that emptied out", () => {
		const out = partitionByPresence(
			groups({ Admin: ["@a"], Member: ["@b"] }),
			statusMap({ "@a": "offline" }),
		);
		expect(out.map((g) => g.role)).toEqual(["Member", "Offline"]);
	});

	it("adds no Offline section when there is nobody in it", () => {
		const out = partitionByPresence(
			groups({ Member: ["@a"] }),
			statusMap({ "@a": "online" }),
		);
		expect(out.map((g) => g.role)).toEqual(["Member"]);
	});

	it("sorts the offline section rather than leaving it role-ordered", () => {
		// It is filled role-by-role, so an offline admin would otherwise come
		// before an offline member - an order whose reason is no longer on
		// screen once the role headings are gone.
		const groups: MemberGroup[] = [
			{ role: "Admin", members: [member("@z", "Zoe")] },
			{ role: "Member", members: [member("@a", "Alice")] },
		];
		const out = partitionByPresence(
			groups,
			statusMap({ "@z": "offline", "@a": "offline" }),
		);
		expect(out.map((g) => g.role)).toEqual(["Offline"]);
		expect(
			requiredAt(out, 0, "offline group").members.map((m) => m.displayName),
		).toEqual(["Alice", "Zoe"]);
	});

	it("preserves order within a section", () => {
		const out = partitionByPresence(
			groups({ Member: ["@a", "@b", "@c"] }),
			statusMap({ "@b": "offline" }),
		);
		expect(
			requiredAt(out, 0, "member group").members.map((m) => m.userId),
		).toEqual(["@a", "@c"]);
	});
});
