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
	/** True while fetching an additional page. */
	loadingMore: boolean;
	error: string | null;
	/** True when the server has more pages to fetch. */
	truncated: boolean;
	/** Fetch the next page of hierarchy rooms. */
	loadMore: () => Promise<void>;
	joinRoom: (roomId: string) => Promise<void>;
	/**
	 * Via servers for a child room from the hierarchy's m.space.child
	 * state (for prefilling the join dialog / knock flow).
	 */
	viaServersFor: (roomId: string) => string[];
	joinState: (roomId: string) => JoinState;
}

const HIERARCHY_LIMIT = 100;
// Depth cap: one level per view. Subspace children are carried through
// (#443), and entering a subspace navigates to its own space view, which
// fetches its own hierarchy - the same one-level-per-expand model Cinny
// uses.
const HIERARCHY_MAX_DEPTH = 1;

/**
 * Hook that fetches the space hierarchy and exposes discoverable rooms
 * and subspaces. Uses createResource for the initial page with automatic
 * stale-request handling, and manual signals for subsequent pages via
 * loadMore().
 */
export function useSpaceHierarchy(
	spaceId: () => string | undefined,
): SpaceHierarchy {
	const { client, summaries, optimisticallyMarkJoined } = useClient();
	const mxcToHttp = (mxcUrl: string): string | null =>
		client.mxcUrlToHttp(mxcUrl, 48, 48, "crop") ?? null;

	type HierarchyResult = {
		rooms: HierarchyRoom[];
		nextBatch: string | null;
	};

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
				nextBatch: result.next_batch ?? null,
			};
		},
	);

	// Subsequent pages accumulated manually
	const [additionalRooms, setAdditionalRooms] = createSignal<HierarchyRoom[]>(
		[],
	);
	const [nextBatch, setNextBatch] = createSignal<string | null | undefined>(
		undefined,
	);
	const [loadingMore, setLoadingMore] = createSignal(false);
	const [joinStates, setJoinStates] = createSignal<Record<string, JoinState>>(
		{},
	);
	// Generation counter — increments on every space change. Async
	// operations capture the current generation and bail if it changed
	// (handles A→B→A where spaceId matches but the session is different).
	let paginationGeneration = 0;

	// Reset all pagination and join state when space changes
	createEffect(() => {
		spaceId();
		paginationGeneration++;
		setLoadingMore(false);
		setAdditionalRooms([]);
		setNextBatch(undefined);
		setJoinStates({});
	});

	// Sync nextBatch from initial page when data arrives
	createEffect(() => {
		if (hierarchy.error) return;
		const data = hierarchy();
		if (data) {
			setNextBatch(data.nextBatch);
			setAdditionalRooms([]);
		}
	});

	// All hierarchy rooms (initial + subsequent pages)
	const allRooms = createMemo((): HierarchyRoom[] => {
		if (hierarchy.error) return [];
		const data = hierarchy();
		if (!data) return [];
		const extra = additionalRooms();
		return extra.length > 0 ? [...data.rooms, ...extra] : data.rooms;
	});

	const discoverableRooms = createMemo((): DiscoverableRoom[] => {
		if (hierarchy.error) return [];
		const rooms = allRooms();
		if (rooms.length === 0) return [];
		const sid = spaceId();
		if (!sid) return [];
		return filterDiscoverableRooms(rooms, sid, summaries, mxcToHttp);
	});

	const joinState = (roomId: string): JoinState =>
		joinStates()[roomId] ?? "idle";

	async function loadMore(): Promise<void> {
		const token = nextBatch();
		const sid = spaceId();
		if (!token || !sid || loadingMore()) return;

		const gen = paginationGeneration;
		setLoadingMore(true);
		try {
			const result = await client.getRoomHierarchy(
				sid,
				HIERARCHY_LIMIT,
				HIERARCHY_MAX_DEPTH,
				false,
				token,
			);
			// Generation guard — catches A→B→A where spaceId matches
			// but paginationGeneration has advanced.
			if (paginationGeneration !== gen) return;
			setAdditionalRooms((prev) => [...prev, ...result.rooms]);
			setNextBatch(result.next_batch ?? null);
		} catch (err) {
			console.error("Failed to load more hierarchy rooms:", err);
		} finally {
			if (paginationGeneration === gen) {
				setLoadingMore(false);
			}
		}
	}

	const joinRoom = async (roomId: string): Promise<void> => {
		const current = joinStates()[roomId];
		if (current === "joining" || current === "joined") return;

		const startSpaceId = spaceId();
		// Capture the pagination generation so we can detect A→B→A
		// navigation: the spaceId may have returned to its original value
		// while we awaited the join, but the generation has advanced.
		const gen = paginationGeneration;
		setJoinStates((prev) => ({ ...prev, [roomId]: "joining" }));

		try {
			const rooms = allRooms();
			const viaServers =
				rooms.length > 0 && startSpaceId
					? extractViaServers(rooms, startSpaceId, roomId)
					: [];
			await client.joinRoom(roomId, { viaServers });
			// Only update state if still on the same space session
			if (paginationGeneration === gen) {
				// Optimistically populate the summary store so the room
				// disappears from Discover and appears in the joined list
				// immediately. `client.joinRoom()` resolves before /sync
				// delivers the room's state, so without this the UI would
				// be stale until the next browser refresh (#132). When the
				// eventual /sync arrives, `ClientEvent.Room` -> `upsertRoom`
				// overwrites this stub with authoritative data.
				const hierarchyRoom = allRooms().find((r) => r.room_id === roomId);
				if (hierarchyRoom) {
					optimisticallyMarkJoined(roomId, {
						name:
							hierarchyRoom.name?.trim() ||
							hierarchyRoom.canonical_alias ||
							roomId,
						avatarUrl: hierarchyRoom.avatar_url
							? mxcToHttp(hierarchyRoom.avatar_url)
							: null,
						// A joined subspace must surface in the spaces sidebar
						// immediately (#443), not after the next /sync delivers
						// the authoritative m.room.create.
						isSpace: hierarchyRoom.room_type === "m.space",
					});
				} else {
					optimisticallyMarkJoined(roomId, { name: roomId, avatarUrl: null });
				}
				setJoinStates((prev) => ({ ...prev, [roomId]: "joined" }));
			}
		} catch (err) {
			console.error(`Failed to join room ${roomId}:`, err);
			if (paginationGeneration === gen) {
				setJoinStates((prev) => ({ ...prev, [roomId]: "error" }));
			}
		}
	};

	/**
	 * Via servers for a child room from the hierarchy's m.space.child
	 * state. SpaceDiscoverList uses this to prefill the join dialog's
	 * knock flow (the dialog owns the actual knockRoom call - a knock
	 * accepts an optional reason, which needs the dialog's UI).
	 */
	const viaServersFor = (roomId: string): string[] => {
		const id = spaceId();
		const rooms = allRooms();
		return rooms.length > 0 && id ? extractViaServers(rooms, id, roomId) : [];
	};

	return {
		get discoverableRooms() {
			return discoverableRooms();
		},
		get loading() {
			return hierarchy.loading;
		},
		get loadingMore() {
			return loadingMore();
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
			if (hierarchy.error) return false;
			// undefined = not yet synced from resource; derive directly.
			// string|null = set by effect or loadMore; use signal value.
			const nb = nextBatch();
			if (nb !== undefined) return !!nb;
			return !!hierarchy()?.nextBatch;
		},
		loadMore,
		joinRoom,
		viaServersFor,
		joinState,
	};
}
