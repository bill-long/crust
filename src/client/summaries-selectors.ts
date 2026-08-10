import type { RoomSummary, SummariesStore } from "./summaries";

/**
 * Rooms inside a space: joined, non-space children sorted by recent activity.
 */
export function getSpaceRooms(
	summaries: SummariesStore,
	spaceId: string,
): RoomSummary[] {
	const space = summaries[spaceId];
	if (!space?.isSpace || space.membership !== "join") return [];

	return space.children
		.map((id) => summaries[id])
		.filter(
			(s): s is RoomSummary =>
				s !== undefined && s.membership === "join" && !s.isSpace,
		)
		.sort(
			(a, b) =>
				(b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0),
		);
}

/**
 * Joined subspaces of a joined space: direct children that are themselves
 * joined spaces, sorted alphabetically (spaces carry no reliable activity
 * timestamp, so name order keeps the section stable). Rendered as rows in
 * the space's room list (#443). A space listing ITSELF as a child
 * (wire-legal nonsense) is excluded - it would render a row that
 * navigates to the view you're already on.
 */
export function getSpaceSubspaces(
	summaries: SummariesStore,
	spaceId: string,
): RoomSummary[] {
	const space = summaries[spaceId];
	if (!space?.isSpace || space.membership !== "join") return [];

	return space.children
		.map((id) => summaries[id])
		.filter(
			(s): s is RoomSummary =>
				s !== undefined &&
				s.roomId !== spaceId &&
				s.membership === "join" &&
				s.isSpace,
		)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Rollup unread + highlight counts for a space's joined non-space
 * descendants: direct child rooms plus, recursively, the rooms of joined
 * subspaces (#443). Traversal is membership-gated (only a joined space
 * exposes an authoritative child list) and cycle-safe - space graphs are
 * user-controlled and can contain A<->B loops or self-references, so each
 * room/space is entered at most once. Iterative so pathologically deep
 * nesting can't overflow the call stack.
 */
export function getSpaceUnreadRollup(
	summaries: SummariesStore,
	spaceId: string,
): { unread: number; highlight: number } {
	const root = summaries[spaceId];
	if (!root?.isSpace || root.membership !== "join")
		return { unread: 0, highlight: 0 };

	let unread = 0;
	let highlight = 0;
	const visited = new Set<string>([spaceId]);
	const stack: string[] = [...root.children];
	while (stack.length > 0) {
		const id = stack.pop();
		if (id === undefined || visited.has(id)) continue;
		visited.add(id);
		const child = summaries[id];
		if (!child || child.membership !== "join") continue;
		if (child.isSpace) {
			for (const grandchildId of child.children) stack.push(grandchildId);
		} else {
			unread += child.unreadCount;
			highlight += child.highlightCount;
		}
	}
	return { unread, highlight };
}

/**
 * Rooms (non-space) the user has a pending invite to, sorted alphabetically.
 * Invites carry no reliable activity timestamp in the summary (invite_state
 * has no messages), so name order keeps the section stable.
 *
 * Includes invited rooms that are children of a joined space - an invite must
 * be discoverable from Home even when the user never opens that space. The
 * space view additionally lists its own children's invites via
 * {@link getSpaceInvitedRooms}.
 */
export function getInvitedRooms(summaries: SummariesStore): RoomSummary[] {
	return Object.values(summaries)
		.filter((s) => !s.isSpace && s.membership === "invite")
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Number of non-space rooms the user has a pending invite to - the size of
 * {@link getInvitedRooms} without the sort/allocation, for badge counts that
 * recompute on every summaries change.
 */
export function getInvitedRoomCount(summaries: SummariesStore): number {
	let count = 0;
	for (const s of Object.values(summaries)) {
		if (!s.isSpace && s.membership === "invite") count++;
	}
	return count;
}

/**
 * Rooms (non-space) the user has a pending join request (knock) in, sorted
 * alphabetically. Mirrors {@link getInvitedRooms}: knock_state carries no
 * activity timestamp, so name order keeps the section stable. Includes
 * knocked rooms that are children of a joined space so a pending request is
 * visible from Home without opening the space.
 */
export function getKnockedRooms(summaries: SummariesStore): RoomSummary[] {
	return Object.values(summaries)
		.filter((s) => !s.isSpace && s.membership === "knock")
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pending join requests among a joined space's direct children, sorted
 * alphabetically. Mirrors {@link getSpaceInvitedRooms}.
 */
export function getSpaceKnockedRooms(
	summaries: SummariesStore,
	spaceId: string,
): RoomSummary[] {
	const space = summaries[spaceId];
	if (!space?.isSpace || space.membership !== "join") return [];

	return space.children
		.map((id) => summaries[id])
		.filter(
			(s): s is RoomSummary =>
				s !== undefined && s.membership === "knock" && !s.isSpace,
		)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Spaces the user has a pending invite to, sorted alphabetically. Rendered in
 * the spaces sidebar alongside joined spaces (with an invite affordance).
 */
export function getInvitedSpaces(summaries: SummariesStore): RoomSummary[] {
	return Object.values(summaries)
		.filter((s) => s.isSpace && s.membership === "invite")
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Spaces the user has a pending join request (knock) in, sorted
 * alphabetically. Surfaced in the spaces sidebar alongside invited spaces:
 * the room-level {@link getKnockedRooms} deliberately excludes spaces, so
 * without this a knocked space would render nowhere after the authoritative
 * sync flags `isSpace` (#442).
 */
export function getKnockedSpaces(summaries: SummariesStore): RoomSummary[] {
	return Object.values(summaries)
		.filter((s) => s.isSpace && s.membership === "knock")
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Pending room invites among a joined space's direct children, sorted
 * alphabetically. Mirrors {@link getSpaceRooms}' space gating: a space the
 * user hasn't joined exposes no authoritative child list.
 */
export function getSpaceInvitedRooms(
	summaries: SummariesStore,
	spaceId: string,
): RoomSummary[] {
	const space = summaries[spaceId];
	if (!space?.isSpace || space.membership !== "join") return [];

	return space.children
		.map((id) => summaries[id])
		.filter(
			(s): s is RoomSummary =>
				s !== undefined && s.membership === "invite" && !s.isSpace,
		)
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Joined spaces, sorted alphabetically.
 */
export function getSpaces(summaries: SummariesStore): RoomSummary[] {
	return Object.values(summaries)
		.filter((s) => s.isSpace && s.membership === "join")
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Deepest nesting tier rendered under a root tile in the spaces sidebar
 * (#443). Roots sit at depth 0, so MAX_SIDEBAR_SPACE_DEPTH = 2 renders a
 * root plus two nested tiers; joined spaces nested deeper fall back to
 * root tiles so nothing disappears from the rail.
 */
export const MAX_SIDEBAR_SPACE_DEPTH = 2;

/** A node in the spaces-sidebar tree: a joined space and its joined
    subspaces, nested up to {@link MAX_SIDEBAR_SPACE_DEPTH}. */
export interface SpaceTreeNode {
	space: RoomSummary;
	children: SpaceTreeNode[];
}

/**
 * Build the spaces-sidebar tree from the summary store (#443).
 *
 * Roots are joined spaces no other joined space claims as a child; each
 * root carries its joined subspaces nested (name-sorted) up to
 * {@link MAX_SIDEBAR_SPACE_DEPTH}. Space graphs are user-controlled and
 * can contain cycles (A contains B contains A), diamonds (two parents
 * sharing a subspace), or self-references, so construction guards with a
 * visited set: every joined space is placed EXACTLY once. Spaces left
 * unplaced after the forest is built (cycle members with no parentless
 * entry point, or spaces nested deeper than the depth cap) are appended
 * as root tiles so they stay reachable.
 */
export function getSpaceTree(summaries: SummariesStore): SpaceTreeNode[] {
	const spaces = getSpaces(summaries);
	const byId = new Map(spaces.map((s) => [s.roomId, s]));

	const hasJoinedParent = new Set<string>();
	for (const space of spaces) {
		for (const childId of space.children) {
			if (byId.has(childId)) hasJoinedParent.add(childId);
		}
	}

	const visited = new Set<string>();
	const build = (space: RoomSummary, depth: number): SpaceTreeNode => {
		visited.add(space.roomId);
		const children: SpaceTreeNode[] = [];
		if (depth < MAX_SIDEBAR_SPACE_DEPTH) {
			const childSpaces = space.children
				.map((id) => byId.get(id))
				.filter((s): s is RoomSummary => s !== undefined)
				.sort((a, b) => a.name.localeCompare(b.name));
			for (const child of childSpaces) {
				// Re-check inside the loop: the children array can list the
				// same id twice, and an earlier sibling's subtree may have
				// claimed this child (diamond).
				if (visited.has(child.roomId)) continue;
				children.push(build(child, depth + 1));
			}
		}
		return { space, children };
	};

	const roots: SpaceTreeNode[] = [];
	for (const space of spaces) {
		if (hasJoinedParent.has(space.roomId) || visited.has(space.roomId))
			continue;
		roots.push(build(space, 0));
	}
	// Cycle members and depth-capped spaces never got placed; append them
	// as roots rather than dropping them from the rail, then re-sort so
	// natural and fallback roots form one name-sorted run.
	for (const space of spaces) {
		if (!visited.has(space.roomId)) roots.push(build(space, 0));
	}
	roots.sort((a, b) => a.space.name.localeCompare(b.space.name));
	return roots;
}

/** Flattened sidebar view of {@link getSpaceTree}: the spaces in render
    order plus each space's nesting depth. The flat list keeps `<For>`
    keyed on stable RoomSummary references (tree nodes are re-minted
    whenever a structural summaries change re-runs the tree memo, and
    re-minted node wrappers would remount every tile). */
export interface FlatSpaceTree {
	spaces: RoomSummary[];
	depths: ReadonlyMap<string, number>;
}

/** Flatten a space tree depth-first into render order. */
export function flattenSpaceTree(tree: SpaceTreeNode[]): FlatSpaceTree {
	const spaces: RoomSummary[] = [];
	const depths = new Map<string, number>();
	const walk = (nodes: SpaceTreeNode[], depth: number): void => {
		for (const node of nodes) {
			spaces.push(node.space);
			depths.set(node.space.roomId, depth);
			walk(node.children, depth + 1);
		}
	};
	walk(tree, 0);
	return { spaces, depths };
}

/**
 * DM rooms the user has joined, sorted by recent activity.
 */
export function getDmRooms(summaries: SummariesStore): RoomSummary[] {
	return Object.values(summaries)
		.filter((s) => s.isDirect && s.membership === "join" && !s.isSpace)
		.sort(
			(a, b) =>
				(b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0),
		);
}

/**
 * Rooms not belonging to any space and not DMs, sorted by recent activity.
 */
export function getOrphanRooms(summaries: SummariesStore): RoomSummary[] {
	const spacedRoomIds = new Set<string>();
	const candidates: RoomSummary[] = [];

	for (const s of Object.values(summaries)) {
		if (s.isSpace && s.membership === "join") {
			for (const childId of s.children) {
				spacedRoomIds.add(childId);
			}
		} else if (!s.isSpace && !s.isDirect && s.membership === "join") {
			candidates.push(s);
		}
	}

	return candidates
		.filter((s) => !spacedRoomIds.has(s.roomId))
		.sort(
			(a, b) =>
				(b.lastMessage?.timestamp ?? 0) - (a.lastMessage?.timestamp ?? 0),
		);
}

/**
 * Total unread notification count across every joined room — the same quantity
 * the push gateway reports as `counts.unread` and sends in the push payload's
 * `unread` field (see `PushPayload`). Used to drive the OS/taskbar app badge
 * from in-app state so it updates the moment unread counts change (e.g. a
 * message is read), rather than only when a push arrives. See the
 * service-worker badge path in `src/sw.ts`.
 *
 * Spaces are skipped (their own notification count is not shown to the user;
 * unread for a space's rooms is counted on the rooms themselves), but unlike
 * `getHomeUnreadRollup` this counts space-child rooms too — the badge reflects
 * everything unread, not just what's visible under Home.
 */
export function getTotalUnread(summaries: SummariesStore): number {
	let unread = 0;
	for (const s of Object.values(summaries)) {
		if (s.membership !== "join" || s.isSpace) continue;
		unread += s.unreadCount;
	}
	return unread;
}

/**
 * Rollup unread + highlight counts for everything shown under Home — i.e. the
 * user's DMs plus orphan (non-space) rooms. Used to badge the Home button in
 * the spaces sidebar so unread DMs/rooms are visible while a space is selected.
 *
 * Counts exactly the rooms `getDmRooms` + `getOrphanRooms` return (joined DMs,
 * plus joined non-space rooms that aren't a child of any joined space), in
 * linear time (two passes over the store). Unlike those two selectors it does
 * not sort or build a result array, since only the totals are needed.
 */
export function getHomeUnreadRollup(summaries: SummariesStore): {
	unread: number;
	highlight: number;
} {
	const spacedRoomIds = new Set<string>();
	for (const s of Object.values(summaries)) {
		if (s.isSpace && s.membership === "join") {
			for (const childId of s.children) spacedRoomIds.add(childId);
		}
	}

	let unread = 0;
	let highlight = 0;
	for (const s of Object.values(summaries)) {
		if (s.membership !== "join" || s.isSpace) continue;
		// DMs always count; non-DM (orphan) rooms count only when they don't
		// belong to a space — those are rolled up under their space instead.
		if (!s.isDirect && spacedRoomIds.has(s.roomId)) continue;
		unread += s.unreadCount;
		highlight += s.highlightCount;
	}
	return { unread, highlight };
}
