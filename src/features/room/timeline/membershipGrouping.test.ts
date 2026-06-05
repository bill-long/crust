import { EventStatus } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import {
	computeMembershipGroups,
	MEMBERSHIP_GROUP_GAP_MS,
	summarizeMembershipGroup,
} from "./membershipGrouping";
import type { MembershipTransitionKind } from "./stateNotice";
import type { TimelineEvent } from "./useTimeline";

const DAY = "2026-01-15T";

function ts(time: string): number {
	return new Date(`${DAY}${time}Z`).getTime();
}

interface EvOpts {
	id: string;
	kind?: MembershipTransitionKind | null;
	at: number;
	status?: TimelineEvent["status"];
	subject?: string;
}

function ev(opts: EvOpts): TimelineEvent {
	return {
		eventId: opts.id,
		timestamp: opts.at,
		status: opts.status ?? null,
		membershipTransition: opts.kind
			? {
					kind: opts.kind,
					userId: `@${opts.subject ?? opts.id}:test`,
					subject: opts.subject ?? opts.id,
					avatarUrl: null,
				}
			: null,
	} as unknown as TimelineEvent;
}

describe("computeMembershipGroups", () => {
	it("groups consecutive same-kind transitions within the window", () => {
		const events = [
			ev({ id: "a", kind: "join", at: ts("10:00:00") }),
			ev({ id: "b", kind: "join", at: ts("10:00:10") }),
			ev({ id: "c", kind: "join", at: ts("10:00:20") }),
		];
		const groups = computeMembershipGroups(events);
		expect(groups[0]).not.toBeNull();
		expect(groups[0]).toBe(groups[1]);
		expect(groups[1]).toBe(groups[2]);
		expect(groups[0]?.leaderIndex).toBe(0);
		expect(groups[0]?.kind).toBe("join");
		expect(groups[0]?.memberEventIds).toEqual(["a", "b", "c"]);
		expect(groups[0]?.memberIndices).toEqual([0, 1, 2]);
	});

	it("does not group a single transition", () => {
		const events = [
			ev({ id: "a", kind: "join", at: ts("10:00:00") }),
			ev({ id: "m", kind: null, at: ts("10:00:05") }),
			ev({ id: "b", kind: "leave", at: ts("10:00:10") }),
		];
		expect(computeMembershipGroups(events)).toEqual([null, null, null]);
	});

	it("breaks a run on a different kind", () => {
		const events = [
			ev({ id: "a", kind: "join", at: ts("10:00:00") }),
			ev({ id: "b", kind: "join", at: ts("10:00:05") }),
			ev({ id: "c", kind: "leave", at: ts("10:00:10") }),
			ev({ id: "d", kind: "leave", at: ts("10:00:15") }),
		];
		const groups = computeMembershipGroups(events);
		expect(groups[0]?.memberEventIds).toEqual(["a", "b"]);
		expect(groups[2]?.memberEventIds).toEqual(["c", "d"]);
		expect(groups[0]).not.toBe(groups[2]);
	});

	it("breaks a run on an interrupting non-transition event", () => {
		const events = [
			ev({ id: "a", kind: "join", at: ts("10:00:00") }),
			ev({ id: "msg", kind: null, at: ts("10:00:05") }),
			ev({ id: "b", kind: "join", at: ts("10:00:10") }),
			ev({ id: "c", kind: "join", at: ts("10:00:15") }),
		];
		const groups = computeMembershipGroups(events);
		expect(groups[0]).toBeNull();
		expect(groups[1]).toBeNull();
		expect(groups[2]?.memberEventIds).toEqual(["b", "c"]);
	});

	it("breaks a run when the gap exceeds the window", () => {
		const events = [
			ev({ id: "a", kind: "join", at: ts("10:00:00") }),
			ev({ id: "b", kind: "join", at: ts("10:00:30") }),
			ev({
				id: "c",
				kind: "join",
				at: ts("10:00:30") + MEMBERSHIP_GROUP_GAP_MS + 1,
			}),
		];
		const groups = computeMembershipGroups(events);
		expect(groups[0]?.memberEventIds).toEqual(["a", "b"]);
		expect(groups[2]).toBeNull();
	});

	it("breaks a run across a day boundary", () => {
		// Construct local-time dates so the day boundary is independent of the
		// runner's timezone (isSameDay compares local calendar days).
		const a = new Date(2026, 0, 15, 23, 59, 50).getTime();
		const b = new Date(2026, 0, 16, 0, 0, 0).getTime();
		const c = new Date(2026, 0, 16, 0, 0, 5).getTime();
		const events = [
			ev({ id: "a", kind: "join", at: a }),
			ev({ id: "b", kind: "join", at: b }),
			ev({ id: "c", kind: "join", at: c }),
		];
		const groups = computeMembershipGroups(events);
		// a is alone (new day starts at b); b+c group.
		expect(groups[0]).toBeNull();
		expect(groups[1]?.memberEventIds).toEqual(["b", "c"]);
	});

	it("excludes pending/failed echoes from grouping", () => {
		const events = [
			ev({ id: "a", kind: "join", at: ts("10:00:00") }),
			ev({
				id: "b",
				kind: "join",
				at: ts("10:00:05"),
				status: EventStatus.NOT_SENT,
			}),
			ev({ id: "c", kind: "join", at: ts("10:00:10") }),
		] as unknown as TimelineEvent[];
		const groups = computeMembershipGroups(events);
		// The failed echo breaks the run; a and c are isolated singletons.
		expect(groups[0]).toBeNull();
		expect(groups[1]).toBeNull();
		expect(groups[2]).toBeNull();
	});
});

describe("summarizeMembershipGroup", () => {
	const m = (names: string[]) =>
		names.map((name, i) => ({ userId: `@${name}-${i}:test`, name }));

	it("formats one subject", () => {
		expect(summarizeMembershipGroup(m(["Alice"]), "join")).toBe("Alice joined");
	});

	it("formats two subjects", () => {
		expect(summarizeMembershipGroup(m(["Alice", "Bob"]), "leave")).toBe(
			"Alice and Bob left",
		);
	});

	it("formats three subjects", () => {
		expect(summarizeMembershipGroup(m(["Alice", "Bob", "Carol"]), "join")).toBe(
			"Alice, Bob and Carol joined",
		);
	});

	it("summarizes more than three with an others count", () => {
		expect(
			summarizeMembershipGroup(m(["Alice", "Bob", "Carol", "Dave"]), "join"),
		).toBe("Alice, Bob and 2 others joined");
	});

	it("dedupes repeated users by userId", () => {
		expect(
			summarizeMembershipGroup(
				[
					{ userId: "@alice:test", name: "Alice" },
					{ userId: "@alice:test", name: "Alice" },
					{ userId: "@bob:test", name: "Bob" },
				],
				"kick",
			),
		).toBe("Alice and Bob were removed");
	});

	it("keeps distinct users who share a display name", () => {
		expect(
			summarizeMembershipGroup(
				[
					{ userId: "@alex1:test", name: "Alex" },
					{ userId: "@alex2:test", name: "Alex" },
				],
				"join",
			),
		).toBe("Alex and Alex joined");
	});

	it("uses kind-specific verbs", () => {
		expect(summarizeMembershipGroup(m(["A", "B"]), "invite")).toBe(
			"A and B were invited",
		);
		expect(summarizeMembershipGroup(m(["A", "B"]), "ban")).toBe(
			"A and B were banned",
		);
	});
});
