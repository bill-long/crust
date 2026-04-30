import type { RoomSummary, SummariesStore } from "./summaries";

/**
 * Rooms inside a space: joined, non-space children sorted by recent activity.
 */
export function getSpaceRooms(
	summaries: SummariesStore,
	spaceId: string,
): RoomSummary[] {
	const space = summaries[spaceId];
	if (!space) return [];

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
	if (!space) return { unread: 0, highlight: 0 };

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
