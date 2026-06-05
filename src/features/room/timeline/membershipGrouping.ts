import { isSameDay } from "./dateFormatting";
import type { MembershipTransitionKind } from "./stateNotice";
import type { TimelineEvent } from "./useTimeline";

/**
 * Max gap between two consecutive membership transitions for them to belong
 * to the same collapsed group. Matches the "burst" window other clients use
 * for join/leave spam.
 */
export const MEMBERSHIP_GROUP_GAP_MS = 60_000;

export interface MembershipGroup {
	/** Index (in the events array) of the first event of the run. */
	leaderIndex: number;
	kind: MembershipTransitionKind;
	/** Indices of every event in the run, in order. Length >= 2. */
	memberIndices: number[];
	/** Event IDs of every event in the run, in order. Length >= 2. */
	memberEventIds: string[];
}

/**
 * Whether an event is eligible to participate in a membership group: it must
 * be a server-confirmed membership transition (join/leave/invite/kick/ban).
 * Pending/failed local echoes and non-transition notices are excluded.
 */
function isGroupable(ev: TimelineEvent): boolean {
	return ev.membershipTransition !== null && ev.status === null;
}

/**
 * Scan a timeline for maximal runs of consecutive, same-kind membership
 * transitions authored within {@link MEMBERSHIP_GROUP_GAP_MS} of each other
 * and on the same calendar day. Runs of length >= 2 become groups; anything
 * else stays individual.
 *
 * Returns an array parallel to `events`: each slot holds the shared
 * `MembershipGroup` for that index, or null when the event is not grouped.
 * The same group object instance is shared by all of its member indices.
 */
export function computeMembershipGroups(
	events: readonly TimelineEvent[],
): (MembershipGroup | null)[] {
	const result: (MembershipGroup | null)[] = new Array(events.length).fill(
		null,
	);

	let runStart = 0;
	while (runStart < events.length) {
		const startEv = events[runStart];
		if (!startEv || !isGroupable(startEv)) {
			runStart++;
			continue;
		}
		const kind = startEv.membershipTransition?.kind;
		let end = runStart + 1;
		let prev = startEv;
		while (end < events.length) {
			const ev = events[end];
			if (
				!ev ||
				!isGroupable(ev) ||
				ev.membershipTransition?.kind !== kind ||
				ev.timestamp - prev.timestamp > MEMBERSHIP_GROUP_GAP_MS ||
				!isSameDay(prev.timestamp, ev.timestamp)
			) {
				break;
			}
			prev = ev;
			end++;
		}

		const length = end - runStart;
		if (length >= 2 && kind) {
			const memberIndices: number[] = [];
			const memberEventIds: string[] = [];
			for (let i = runStart; i < end; i++) {
				memberIndices.push(i);
				memberEventIds.push(events[i].eventId);
			}
			const group: MembershipGroup = {
				leaderIndex: runStart,
				kind,
				memberIndices,
				memberEventIds,
			};
			for (const i of memberIndices) result[i] = group;
		}
		runStart = end;
	}

	return result;
}

const KIND_VERB: Record<MembershipTransitionKind, string> = {
	join: "joined",
	leave: "left",
	invite: "were invited",
	kick: "were removed",
	ban: "were banned",
};

const KIND_VERB_SINGULAR: Record<MembershipTransitionKind, string> = {
	join: "joined",
	leave: "left",
	invite: "was invited",
	kick: "was removed",
	ban: "was banned",
};

/**
 * Build the collapsed summary line for a membership group, e.g.
 * "Alice, Bob and 3 others joined". Members are the affected users in run
 * order; duplicates are removed by `userId` (a stable key, so two distinct
 * users who share a display name are not collapsed into one) while preserving
 * order and the displayed `name`.
 */
export function summarizeMembershipGroup(
	members: readonly { userId: string; name: string }[],
	kind: MembershipTransitionKind,
): string {
	const unique: string[] = [];
	const seen = new Set<string>();
	for (const m of members) {
		if (!seen.has(m.userId)) {
			seen.add(m.userId);
			unique.push(m.name);
		}
	}

	const count = unique.length;
	if (count === 0) return KIND_VERB[kind];
	if (count === 1) return `${unique[0]} ${KIND_VERB_SINGULAR[kind]}`;
	if (count === 2) return `${unique[0]} and ${unique[1]} ${KIND_VERB[kind]}`;
	if (count === 3)
		return `${unique[0]}, ${unique[1]} and ${unique[2]} ${KIND_VERB[kind]}`;
	const others = count - 2;
	return `${unique[0]}, ${unique[1]} and ${others} others ${KIND_VERB[kind]}`;
}
