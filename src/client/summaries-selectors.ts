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
 * Rollup unread + highlight counts for a space's direct joined non-space children.
 */
export function getSpaceUnreadRollup(
	summaries: SummariesStore,
	spaceId: string,
): { unread: number; highlight: number } {
	const space = summaries[spaceId];
	if (!space?.isSpace || space.membership !== "join")
		return { unread: 0, highlight: 0 };

	let unread = 0;
	let highlight = 0;
	for (const childId of space.children) {
		const child = summaries[childId];
		if (child && child.membership === "join" && !child.isSpace) {
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
