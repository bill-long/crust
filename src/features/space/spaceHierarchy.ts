import type { HierarchyRoom } from "matrix-js-sdk";
import type { SummariesStore } from "../../client/summaries";

export interface DiscoverableRoom {
	roomId: string;
	name: string;
	avatarUrl: string | null;
	topic: string | null;
	memberCount: number;
	joinRule: string | null;
	/** Whether the user can self-join (public or restricted with space membership). */
	canJoin: boolean;
}

/** Extract via servers for a child room from the space hierarchy response. */
export function extractViaServers(
	hierarchyRooms: HierarchyRoom[],
	spaceId: string,
	childRoomId: string,
): string[] {
	const spaceEntry = hierarchyRooms.find((r) => r.room_id === spaceId);
	if (!spaceEntry) return [];

	const childRelation = spaceEntry.children_state.find(
		(cs) => cs.state_key === childRoomId,
	);
	return childRelation?.content?.via ?? [];
}

/** Filter hierarchy rooms to only discoverable (non-joined, non-space) rooms. */
export function filterDiscoverableRooms(
	hierarchyRooms: HierarchyRoom[],
	spaceId: string,
	summaries: SummariesStore,
	mxcToHttp: (mxcUrl: string) => string | null,
): DiscoverableRoom[] {
	return hierarchyRooms
		.filter((room) => {
			if (room.room_id === spaceId) return false;
			if (room.room_type === "m.space") return false;
			if (summaries[room.room_id]?.membership === "join") return false;
			return true;
		})
		.map((room) => {
			// The SDK types join_rule as only Public | Knock, but the API
			// can return any JoinRule value including "restricted".
			const rule = room.join_rule as string | undefined;
			return {
				roomId: room.room_id,
				name: room.name ?? room.canonical_alias ?? room.room_id,
				avatarUrl: room.avatar_url ? mxcToHttp(room.avatar_url) : null,
				topic: room.topic ?? null,
				memberCount: room.num_joined_members,
				joinRule: rule ?? null,
				canJoin: rule === "public" || rule === "restricted",
			};
		});
}
