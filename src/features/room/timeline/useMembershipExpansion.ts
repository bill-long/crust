import { createEffect, createMemo, createSignal } from "solid-js";
import {
	computeMembershipGroups,
	type MembershipGroup,
} from "./membershipGrouping";
import type { TimelineEvent } from "./timelineTypes";

/**
 * Membership-group expansion state for the timeline. Groups consecutive
 * same-kind membership transitions (join/leave/invite/kick/ban) so a burst
 * doesn't drown out real messages, and tracks which groups the user has
 * expanded.
 *
 * Expansion is keyed by member event ID so it survives pagination (array
 * indices shift, event IDs don't). The expanded set is pruned to IDs still
 * present in a current group, which also clears it naturally on room switch
 * (the events - and thus their IDs - change). Both the prune effect and the
 * per-row memo register under the caller's reactive owner.
 */
export function useMembershipExpansion(events: TimelineEvent[]) {
	// Recomputed when the loaded events change.
	const membershipGroups = createMemo(() => computeMembershipGroups(events));
	const [expandedMemberIds, setExpandedMemberIds] = createSignal<
		ReadonlySet<string>
	>(new Set());
	const isGroupExpanded = (group: MembershipGroup): boolean => {
		const set = expandedMemberIds();
		return group.memberEventIds.some((id) => set.has(id));
	};
	const expandGroup = (group: MembershipGroup): void => {
		setExpandedMemberIds((prev) => {
			const next = new Set(prev);
			for (const id of group.memberEventIds) next.add(id);
			return next;
		});
	};
	const collapseGroup = (group: MembershipGroup): void => {
		setExpandedMemberIds((prev) => {
			const next = new Set(prev);
			for (const id of group.memberEventIds) next.delete(id);
			return next;
		});
	};
	const groupMembers = (
		group: MembershipGroup,
	): { userId: string; name: string; avatarUrl: string | null }[] =>
		group.memberIndices.map((mi) => {
			const e = events[mi];
			const mt = e?.membershipTransition;
			return {
				userId: mt?.userId ?? e?.senderId ?? "",
				name: mt?.subject ?? e?.senderName ?? "",
				avatarUrl: mt?.avatarUrl ?? null,
			};
		});

	// Prune expansion state to event IDs still present in a current group.
	// Without this the Set would accumulate IDs forever as the user expands
	// groups and as events scroll out of the loaded window; it also clears
	// naturally on room switch (the events - and thus their IDs - change).
	createEffect(() => {
		const groups = membershipGroups();
		setExpandedMemberIds((prev) => {
			if (prev.size === 0) return prev;
			// The same group object repeats at every member index; add each
			// group's IDs once by visiting only its leader index.
			const present = new Set<string>();
			groups.forEach((g, i) => {
				if (g && g.leaderIndex === i) {
					for (const id of g.memberEventIds) present.add(id);
				}
			});
			let changed = false;
			const next = new Set<string>();
			for (const id of prev) {
				if (present.has(id)) next.add(id);
				else changed = true;
			}
			return changed ? next : prev;
		});
	});

	// Per-row "expanded" lookup, precomputed once per change of groups or
	// expansion state. Each group's membership IDs are scanned at most once
	// (visiting only the leader index), so the virtualizer render prop can
	// read O(1) per row instead of re-scanning the run for every member row.
	const expandedByIndex = createMemo<boolean[]>(() => {
		const groups = membershipGroups();
		const set = expandedMemberIds();
		const out = new Array<boolean>(groups.length).fill(false);
		groups.forEach((g, i) => {
			if (g && g.leaderIndex === i) {
				const expanded = g.memberEventIds.some((id) => set.has(id));
				if (expanded) for (const mi of g.memberIndices) out[mi] = true;
			}
		});
		return out;
	});

	return {
		membershipGroups,
		isGroupExpanded,
		expandGroup,
		collapseGroup,
		groupMembers,
		expandedByIndex,
	};
}
