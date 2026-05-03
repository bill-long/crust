import type { HierarchyRoom } from "matrix-js-sdk";
import {
	createEffect,
	createMemo,
	createResource,
	createSignal,
} from "solid-js";
import { useClient } from "../../client/client";
import {
	type DiscoverableRoom,
	extractViaServers,
	filterDiscoverableRooms,
} from "./spaceHierarchy";

export type { DiscoverableRoom } from "./spaceHierarchy";

/** Per-room state while a join request is in flight. */
export type JoinState = "idle" | "joining" | "joined" | "error";

export interface SpaceHierarchy {
	discoverableRooms: DiscoverableRoom[];
	loading: boolean;
	error: string | null;
	/** True when the server returned more pages we didn't fetch. */
	truncated: boolean;
	joinRoom: (roomId: string) => Promise<void>;
	joinState: (roomId: string) => JoinState;
}

const HIERARCHY_LIMIT = 100;
const HIERARCHY_MAX_DEPTH = 1;

/**
 * Hook that fetches the space hierarchy and exposes discoverable rooms.
 * Uses createResource for automatic stale-request handling.
 */
export function useSpaceHierarchy(
	spaceId: () => string | undefined,
): SpaceHierarchy {
	const { client, summaries } = useClient();
	const mxcToHttp = (mxcUrl: string): string | null =>
		client.mxcUrlToHttp(mxcUrl, 48, 48, "crop") ?? null;

	type HierarchyResult = { rooms: HierarchyRoom[]; truncated: boolean };

	const [hierarchy] = createResource(
		spaceId,
		async (id): Promise<HierarchyResult> => {
			const result = await client.getRoomHierarchy(
				id,
				HIERARCHY_LIMIT,
				HIERARCHY_MAX_DEPTH,
				false,
			);
			return {
				rooms: result.rooms,
				truncated: !!result.next_batch,
			};
		},
	);

	const discoverableRooms = createMemo((): DiscoverableRoom[] => {
		const data = hierarchy();
		if (!data) return [];
		const sid = spaceId();
		if (!sid) return [];
		return filterDiscoverableRooms(data.rooms, sid, summaries, mxcToHttp);
	});

	const [joinStates, setJoinStates] = createSignal<Record<string, JoinState>>(
		{},
	);

	// Clear join states when navigating to a different space
	createEffect(() => {
		spaceId();
		setJoinStates({});
	});

	const joinState = (roomId: string): JoinState =>
		joinStates()[roomId] ?? "idle";

	const joinRoom = async (roomId: string): Promise<void> => {
		const current = joinStates()[roomId];
		if (current === "joining" || current === "joined") return;

		setJoinStates((prev) => ({ ...prev, [roomId]: "joining" }));

		try {
			const data = hierarchy();
			const sid = spaceId();
			const viaServers =
				data && sid ? extractViaServers(data.rooms, sid, roomId) : [];
			await client.joinRoom(roomId, { viaServers });
			setJoinStates((prev) => ({ ...prev, [roomId]: "joined" }));
		} catch (err) {
			console.error(`Failed to join room ${roomId}:`, err);
			setJoinStates((prev) => ({ ...prev, [roomId]: "error" }));
		}
	};

	return {
		get discoverableRooms() {
			return discoverableRooms();
		},
		get loading() {
			return hierarchy.loading;
		},
		get error() {
			if (hierarchy.error) {
				const msg =
					hierarchy.error instanceof Error
						? hierarchy.error.message
						: String(hierarchy.error);
				return msg;
			}
			return null;
		},
		get truncated() {
			return hierarchy()?.truncated ?? false;
		},
		joinRoom,
		joinState,
	};
}
