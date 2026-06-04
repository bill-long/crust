import type { HierarchyRoom } from "matrix-js-sdk";
import { createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RoomSummary, SummariesStore } from "../../client/summaries";

// Mock useClient before importing the hook
vi.mock("../../client/client", () => ({
	useClient: vi.fn(),
}));

import { useClient } from "../../client/client";
import { useSpaceHierarchy } from "./useSpaceHierarchy";

/** Run a test inside createRoot with proper error propagation. */
function withRoot(fn: (dispose: () => void) => Promise<void>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		createRoot(async (dispose) => {
			let disposed = false;
			const safeDispose = () => {
				if (!disposed) {
					disposed = true;
					dispose();
				}
			};
			try {
				await fn(safeDispose);
				safeDispose();
				resolve();
			} catch (e) {
				safeDispose();
				reject(e);
			}
		});
	});
}

function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeHierarchyRoom(
	roomId: string,
	overrides: Partial<HierarchyRoom> = {},
): HierarchyRoom {
	return {
		room_id: roomId,
		name: overrides.name ?? roomId,
		avatar_url: overrides.avatar_url,
		topic: overrides.topic,
		canonical_alias: overrides.canonical_alias,
		aliases: overrides.aliases,
		world_readable: overrides.world_readable ?? false,
		guest_can_join: overrides.guest_can_join ?? false,
		num_joined_members: overrides.num_joined_members ?? 5,
		room_type: overrides.room_type,
		join_rule: overrides.join_rule ?? ("public" as HierarchyRoom["join_rule"]),
		children_state: overrides.children_state ?? [],
	};
}

function setupMockClient(overrides: Record<string, unknown> = {}) {
	const mockClient = {
		getRoomHierarchy: vi.fn(),
		mxcUrlToHttp: (mxcUrl: string) =>
			mxcUrl.replace(
				"mxc://",
				"https://example.com/_matrix/media/v3/download/",
			),
		joinRoom: vi.fn(),
		...overrides,
	};
	// Use a real Solid store so memos in useSpaceHierarchy re-run when
	// optimisticallyMarkJoined mutates membership.
	const [summaries, setSummaries] = createStore<SummariesStore>({});
	const optimisticallyMarkJoined = vi.fn(
		(roomId: string, info: { name: string; avatarUrl: string | null }) => {
			const stub: RoomSummary = {
				roomId,
				name: info.name,
				avatarUrl: info.avatarUrl,
				lastMessage: null,
				unreadCount: 0,
				highlightCount: 0,
				membership: "join",
				isEncrypted: false,
				isDirect: false,
				isSpace: false,
				kind: "text",
				callActive: false,
				children: [],
			};
			setSummaries(roomId, stub);
		},
	);

	(useClient as Mock).mockReturnValue({
		client: mockClient,
		summaries,
		optimisticallyMarkJoined,
	});

	return { mockClient, summaries, optimisticallyMarkJoined };
}

describe("useSpaceHierarchy", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("shows loading state then returns discoverable rooms", async () => {
		const { mockClient } = setupMockClient();
		const spaceRoom = makeHierarchyRoom("!space:x", {
			room_type: "m.space",
		});
		const childRoom = makeHierarchyRoom("!child:x", {
			name: "General",
		});
		mockClient.getRoomHierarchy.mockResolvedValue({
			rooms: [spaceRoom, childRoom],
		});

		await withRoot(async () => {
			const hierarchy = useSpaceHierarchy(() => "!space:x");

			// Initially loading
			expect(hierarchy.loading).toBe(true);
			expect(hierarchy.discoverableRooms).toEqual([]);

			await flushPromises();

			expect(hierarchy.loading).toBe(false);
			expect(hierarchy.error).toBeNull();
			expect(hierarchy.discoverableRooms).toHaveLength(1);
			expect(hierarchy.discoverableRooms[0].roomId).toBe("!child:x");
			expect(hierarchy.discoverableRooms[0].name).toBe("General");
		});
	});

	it("surfaces error message on fetch failure", async () => {
		const { mockClient } = setupMockClient();
		mockClient.getRoomHierarchy.mockRejectedValue(new Error("Not authorized"));

		await withRoot(async () => {
			const hierarchy = useSpaceHierarchy(() => "!space:x");
			await flushPromises();

			expect(hierarchy.loading).toBe(false);
			expect(hierarchy.error).toBe("Not authorized");
			expect(hierarchy.discoverableRooms).toEqual([]);
			expect(hierarchy.truncated).toBe(false);
		});
	});

	it("reports truncated when next_batch is present", async () => {
		const { mockClient } = setupMockClient();
		mockClient.getRoomHierarchy.mockResolvedValue({
			rooms: [
				makeHierarchyRoom("!space:x", { room_type: "m.space" }),
				makeHierarchyRoom("!room:x"),
			],
			next_batch: "page2token",
		});

		await withRoot(async () => {
			const hierarchy = useSpaceHierarchy(() => "!space:x");
			await flushPromises();

			expect(hierarchy.truncated).toBe(true);
		});
	});

	it("transitions join state: idle → joining → joined", async () => {
		const { mockClient } = setupMockClient();
		let resolveJoin = () => {};
		const joinPromise = new Promise<void>((r) => {
			resolveJoin = r;
		});
		mockClient.joinRoom.mockReturnValue(joinPromise);
		mockClient.getRoomHierarchy.mockResolvedValue({
			rooms: [
				makeHierarchyRoom("!space:x", {
					room_type: "m.space",
					children_state: [
						{
							type: "m.space.child",
							state_key: "!room:x",
							content: { via: ["example.com"] },
							sender: "@admin:x",
							origin_server_ts: 1000,
						},
					],
				}),
				makeHierarchyRoom("!room:x"),
			],
		});

		await withRoot(async () => {
			const hierarchy = useSpaceHierarchy(() => "!space:x");
			await flushPromises();

			// Initially idle
			expect(hierarchy.joinState("!room:x")).toBe("idle");

			// Start join
			const joinDone = hierarchy.joinRoom("!room:x");
			await flushPromises();
			expect(hierarchy.joinState("!room:x")).toBe("joining");

			// Resolve join
			resolveJoin();
			await joinDone;
			await flushPromises();
			expect(hierarchy.joinState("!room:x")).toBe("joined");

			// Verify via servers were passed
			expect(mockClient.joinRoom).toHaveBeenCalledWith("!room:x", {
				viaServers: ["example.com"],
			});
		});
	});

	it("suppresses duplicate join while already joining", async () => {
		const { mockClient } = setupMockClient();
		let resolveJoin = () => {};
		mockClient.joinRoom.mockReturnValue(
			new Promise<void>((r) => {
				resolveJoin = r;
			}),
		);
		mockClient.getRoomHierarchy.mockResolvedValue({
			rooms: [
				makeHierarchyRoom("!space:x", { room_type: "m.space" }),
				makeHierarchyRoom("!room:x"),
			],
		});

		await withRoot(async () => {
			const hierarchy = useSpaceHierarchy(() => "!space:x");
			await flushPromises();

			// First join call
			hierarchy.joinRoom("!room:x");
			await flushPromises();
			expect(hierarchy.joinState("!room:x")).toBe("joining");

			// Second join call — should be suppressed
			hierarchy.joinRoom("!room:x");
			await flushPromises();

			// joinRoom should only have been called once
			expect(mockClient.joinRoom).toHaveBeenCalledTimes(1);

			resolveJoin();
		});
	});

	it("clears join state when space changes", async () => {
		const { mockClient } = setupMockClient();
		mockClient.joinRoom.mockResolvedValue(undefined);
		mockClient.getRoomHierarchy.mockResolvedValue({
			rooms: [
				makeHierarchyRoom("!space:x", { room_type: "m.space" }),
				makeHierarchyRoom("!room:x"),
			],
		});

		await withRoot(async () => {
			const [spaceId, setSpaceId] = createSignal<string | undefined>(
				"!space:x",
			);
			const hierarchy = useSpaceHierarchy(spaceId);
			await flushPromises();

			// Join a room
			await hierarchy.joinRoom("!room:x");
			await flushPromises();
			expect(hierarchy.joinState("!room:x")).toBe("joined");

			// Switch spaces
			mockClient.getRoomHierarchy.mockResolvedValue({
				rooms: [
					makeHierarchyRoom("!space2:x", { room_type: "m.space" }),
					makeHierarchyRoom("!room2:x"),
				],
			});
			setSpaceId("!space2:x");
			await flushPromises();

			// Old join state should be cleared
			expect(hierarchy.joinState("!room:x")).toBe("idle");
		});
	});

	it("guards against stale join success after space switch", async () => {
		const { mockClient } = setupMockClient();
		let resolveJoin = () => {};
		mockClient.joinRoom.mockReturnValue(
			new Promise<void>((r) => {
				resolveJoin = r;
			}),
		);
		mockClient.getRoomHierarchy.mockResolvedValue({
			rooms: [
				makeHierarchyRoom("!space:x", { room_type: "m.space" }),
				makeHierarchyRoom("!room:x"),
			],
		});

		await withRoot(async () => {
			const [spaceId, setSpaceId] = createSignal<string | undefined>(
				"!space:x",
			);
			const hierarchy = useSpaceHierarchy(spaceId);
			await flushPromises();

			// Start join
			const joinDone = hierarchy.joinRoom("!room:x");
			await flushPromises();
			expect(hierarchy.joinState("!room:x")).toBe("joining");

			// Switch spaces BEFORE join resolves
			mockClient.getRoomHierarchy.mockResolvedValue({
				rooms: [makeHierarchyRoom("!space2:x", { room_type: "m.space" })],
			});
			setSpaceId("!space2:x");
			await flushPromises();

			// Join state cleared by space switch
			expect(hierarchy.joinState("!room:x")).toBe("idle");

			// Now resolve the stale join
			resolveJoin();
			await joinDone;
			await flushPromises();

			// Should NOT have written "joined" state (stale guard)
			expect(hierarchy.joinState("!room:x")).toBe("idle");
		});
	});

	it("guards against stale join error after space switch", async () => {
		const { mockClient } = setupMockClient();
		let rejectJoin = (_err: Error) => {};
		mockClient.joinRoom.mockReturnValue(
			new Promise<void>((_resolve, reject) => {
				rejectJoin = reject;
			}),
		);
		mockClient.getRoomHierarchy.mockResolvedValue({
			rooms: [
				makeHierarchyRoom("!space:x", { room_type: "m.space" }),
				makeHierarchyRoom("!room:x"),
			],
		});

		await withRoot(async () => {
			const [spaceId, setSpaceId] = createSignal<string | undefined>(
				"!space:x",
			);
			const hierarchy = useSpaceHierarchy(spaceId);
			await flushPromises();

			// Start join
			const joinDone = hierarchy.joinRoom("!room:x");
			await flushPromises();
			expect(hierarchy.joinState("!room:x")).toBe("joining");

			// Switch spaces BEFORE join fails
			mockClient.getRoomHierarchy.mockResolvedValue({
				rooms: [makeHierarchyRoom("!space2:x", { room_type: "m.space" })],
			});
			setSpaceId("!space2:x");
			await flushPromises();

			// Reject the stale join
			rejectJoin(new Error("rate limited"));
			await joinDone;
			await flushPromises();

			// Should NOT have written "error" state (stale guard)
			expect(hierarchy.joinState("!room:x")).toBe("idle");
		});
	});

	it("loads additional pages via loadMore", async () => {
		const { mockClient } = setupMockClient();
		mockClient.getRoomHierarchy.mockResolvedValueOnce({
			rooms: [
				makeHierarchyRoom("!space:x", { room_type: "m.space" }),
				makeHierarchyRoom("!room1:x"),
			],
			next_batch: "page2",
		});

		await withRoot(async () => {
			const hierarchy = useSpaceHierarchy(() => "!space:x");
			await flushPromises();

			expect(hierarchy.discoverableRooms).toHaveLength(1);
			expect(hierarchy.truncated).toBe(true);

			// Set up page 2 response
			mockClient.getRoomHierarchy.mockResolvedValueOnce({
				rooms: [makeHierarchyRoom("!room2:x")],
			});

			await hierarchy.loadMore();
			await flushPromises();

			expect(hierarchy.discoverableRooms).toHaveLength(2);
			expect(hierarchy.discoverableRooms[0].roomId).toBe("!room1:x");
			expect(hierarchy.discoverableRooms[1].roomId).toBe("!room2:x");
			expect(hierarchy.truncated).toBe(false);

			// Verify pagination token was passed
			expect(mockClient.getRoomHierarchy).toHaveBeenCalledWith(
				"!space:x",
				100,
				1,
				false,
				"page2",
			);
		});
	});

	it("tracks loadingMore state during pagination", async () => {
		const { mockClient } = setupMockClient();
		mockClient.getRoomHierarchy.mockResolvedValueOnce({
			rooms: [makeHierarchyRoom("!space:x", { room_type: "m.space" })],
			next_batch: "page2",
		});

		await withRoot(async () => {
			const hierarchy = useSpaceHierarchy(() => "!space:x");
			await flushPromises();

			expect(hierarchy.loadingMore).toBe(false);

			let resolvePage2 = () => {};
			mockClient.getRoomHierarchy.mockReturnValueOnce(
				new Promise((r) => {
					resolvePage2 = () => r({ rooms: [makeHierarchyRoom("!room:x")] });
				}),
			);

			const loadDone = hierarchy.loadMore();
			await flushPromises();
			expect(hierarchy.loadingMore).toBe(true);

			resolvePage2();
			await loadDone;
			await flushPromises();
			expect(hierarchy.loadingMore).toBe(false);
		});
	});

	it("resets pagination state on space switch", async () => {
		const { mockClient } = setupMockClient();
		mockClient.getRoomHierarchy.mockResolvedValueOnce({
			rooms: [
				makeHierarchyRoom("!space1:x", { room_type: "m.space" }),
				makeHierarchyRoom("!room1:x"),
			],
			next_batch: "page2",
		});

		await withRoot(async () => {
			const [spaceId, setSpaceId] = createSignal<string | undefined>(
				"!space1:x",
			);
			const hierarchy = useSpaceHierarchy(spaceId);
			await flushPromises();

			expect(hierarchy.discoverableRooms).toHaveLength(1);
			expect(hierarchy.truncated).toBe(true);

			// Load page 2
			mockClient.getRoomHierarchy.mockResolvedValueOnce({
				rooms: [makeHierarchyRoom("!room2:x")],
			});
			await hierarchy.loadMore();
			await flushPromises();
			expect(hierarchy.discoverableRooms).toHaveLength(2);

			// Switch space — pagination should reset
			mockClient.getRoomHierarchy.mockResolvedValueOnce({
				rooms: [
					makeHierarchyRoom("!space2:x", { room_type: "m.space" }),
					makeHierarchyRoom("!room3:x"),
				],
			});
			setSpaceId("!space2:x");
			await flushPromises();

			// Only the new space's rooms, no carryover
			expect(hierarchy.discoverableRooms).toHaveLength(1);
			expect(hierarchy.discoverableRooms[0].roomId).toBe("!room3:x");
			expect(hierarchy.truncated).toBe(false);
		});
	});

	it("guards loadMore against stale space switch", async () => {
		const { mockClient } = setupMockClient();
		mockClient.getRoomHierarchy.mockResolvedValueOnce({
			rooms: [makeHierarchyRoom("!space:x", { room_type: "m.space" })],
			next_batch: "page2",
		});

		await withRoot(async () => {
			const [spaceId, setSpaceId] = createSignal<string | undefined>(
				"!space:x",
			);
			const hierarchy = useSpaceHierarchy(spaceId);
			await flushPromises();

			// Start loading more
			let resolvePage2 = () => {};
			mockClient.getRoomHierarchy.mockReturnValueOnce(
				new Promise((r) => {
					resolvePage2 = () => r({ rooms: [makeHierarchyRoom("!room:x")] });
				}),
			);
			const loadDone = hierarchy.loadMore();
			await flushPromises();

			// Switch space before loadMore resolves
			mockClient.getRoomHierarchy.mockResolvedValueOnce({
				rooms: [makeHierarchyRoom("!space2:x", { room_type: "m.space" })],
			});
			setSpaceId("!space2:x");
			await flushPromises();

			// Resolve stale loadMore
			resolvePage2();
			await loadDone;
			await flushPromises();

			// Should NOT have added rooms from stale page
			expect(hierarchy.discoverableRooms).toHaveLength(0);
		});
	});

	it("resets loadingMore after loadMore error", async () => {
		const { mockClient } = setupMockClient();
		mockClient.getRoomHierarchy.mockResolvedValueOnce({
			rooms: [makeHierarchyRoom("!space:x", { room_type: "m.space" })],
			next_batch: "page2",
		});

		await withRoot(async () => {
			const hierarchy = useSpaceHierarchy(() => "!space:x");
			await flushPromises();

			// Page 2 fails
			mockClient.getRoomHierarchy.mockRejectedValueOnce(
				new Error("Server error"),
			);

			await hierarchy.loadMore();
			await flushPromises();

			// loadingMore should be reset, truncated still true (can retry)
			expect(hierarchy.loadingMore).toBe(false);
			expect(hierarchy.truncated).toBe(true);
		});
	});

	it("optimistically marks the joined room as 'join' in summaries (#132)", async () => {
		const { mockClient, summaries, optimisticallyMarkJoined } =
			setupMockClient();
		mockClient.joinRoom.mockResolvedValue(undefined);
		mockClient.getRoomHierarchy.mockResolvedValue({
			rooms: [
				makeHierarchyRoom("!space:x", { room_type: "m.space" }),
				makeHierarchyRoom("!room:x", {
					name: "General",
					avatar_url: "mxc://example.com/abc",
				}),
			],
		});

		await withRoot(async () => {
			const hierarchy = useSpaceHierarchy(() => "!space:x");
			await flushPromises();

			// Before the join the room is discoverable.
			expect(
				hierarchy.discoverableRooms.find((r) => r.roomId === "!room:x"),
			).toBeDefined();
			expect(summaries["!room:x"]).toBeUndefined();

			await hierarchy.joinRoom("!room:x");
			await flushPromises();

			// The hook seeded a summary stub so the joined-channels list can
			// pick the room up immediately, without waiting on /sync.
			expect(optimisticallyMarkJoined).toHaveBeenCalledWith("!room:x", {
				name: "General",
				avatarUrl:
					"https://example.com/_matrix/media/v3/download/example.com/abc",
			});
			expect(summaries["!room:x"]?.membership).toBe("join");

			// And the room is gone from Discover because filterDiscoverableRooms
			// excludes anything with membership='join'.
			expect(
				hierarchy.discoverableRooms.find((r) => r.roomId === "!room:x"),
			).toBeUndefined();
		});
	});

	it("falls back to canonical_alias / roomId when hierarchy name is missing", async () => {
		const { mockClient, optimisticallyMarkJoined } = setupMockClient();
		mockClient.joinRoom.mockResolvedValue(undefined);
		mockClient.getRoomHierarchy.mockResolvedValue({
			rooms: [
				makeHierarchyRoom("!space:x", { room_type: "m.space" }),
				makeHierarchyRoom("!room:x", {
					name: "   ",
					canonical_alias: "#general:x",
				}),
			],
		});

		await withRoot(async () => {
			const hierarchy = useSpaceHierarchy(() => "!space:x");
			await flushPromises();

			await hierarchy.joinRoom("!room:x");
			await flushPromises();

			expect(optimisticallyMarkJoined).toHaveBeenCalledWith("!room:x", {
				name: "#general:x",
				avatarUrl: null,
			});
		});
	});

	it("does not mark joined when the join fails", async () => {
		const { mockClient, optimisticallyMarkJoined } = setupMockClient();
		mockClient.joinRoom.mockRejectedValue(new Error("forbidden"));
		mockClient.getRoomHierarchy.mockResolvedValue({
			rooms: [
				makeHierarchyRoom("!space:x", { room_type: "m.space" }),
				makeHierarchyRoom("!room:x"),
			],
		});

		await withRoot(async () => {
			const hierarchy = useSpaceHierarchy(() => "!space:x");
			await flushPromises();

			await hierarchy.joinRoom("!room:x");
			await flushPromises();

			expect(hierarchy.joinState("!room:x")).toBe("error");
			expect(optimisticallyMarkJoined).not.toHaveBeenCalled();
		});
	});

	it("does not mark joined when the user navigated to a different space mid-join", async () => {
		const { mockClient, optimisticallyMarkJoined } = setupMockClient();
		let resolveJoin = () => {};
		mockClient.joinRoom.mockReturnValue(
			new Promise<void>((r) => {
				resolveJoin = r;
			}),
		);
		mockClient.getRoomHierarchy.mockResolvedValue({
			rooms: [
				makeHierarchyRoom("!space:x", { room_type: "m.space" }),
				makeHierarchyRoom("!room:x"),
			],
		});

		await withRoot(async () => {
			const [spaceId, setSpaceId] = createSignal<string | undefined>(
				"!space:x",
			);
			const hierarchy = useSpaceHierarchy(spaceId);
			await flushPromises();

			const joinDone = hierarchy.joinRoom("!room:x");
			await flushPromises();

			mockClient.getRoomHierarchy.mockResolvedValue({
				rooms: [makeHierarchyRoom("!space2:x", { room_type: "m.space" })],
			});
			setSpaceId("!space2:x");
			await flushPromises();

			resolveJoin();
			await joinDone;
			await flushPromises();

			expect(optimisticallyMarkJoined).not.toHaveBeenCalled();
		});
	});

	it("does not mark joined on A→B→A reincarnation race", async () => {
		// User clicks Join in space A, then navigates B then back to A.
		// `spaceId() === startSpaceId` would erroneously pass (both are A)
		// even though the pagination/session generation has advanced; the
		// generation guard catches this so stale completions don't write
		// optimistic state into the fresh A session.
		const { mockClient, optimisticallyMarkJoined } = setupMockClient();
		let resolveJoin = () => {};
		mockClient.joinRoom.mockReturnValue(
			new Promise<void>((r) => {
				resolveJoin = r;
			}),
		);
		mockClient.getRoomHierarchy.mockResolvedValue({
			rooms: [
				makeHierarchyRoom("!space:A", { room_type: "m.space" }),
				makeHierarchyRoom("!room:x"),
			],
		});

		await withRoot(async () => {
			const [spaceId, setSpaceId] = createSignal<string | undefined>(
				"!space:A",
			);
			const hierarchy = useSpaceHierarchy(spaceId);
			await flushPromises();

			const joinDone = hierarchy.joinRoom("!room:x");
			await flushPromises();

			// Navigate A → B → A while the join is in flight.
			setSpaceId("!space:B");
			await flushPromises();
			setSpaceId("!space:A");
			await flushPromises();

			resolveJoin();
			await joinDone;
			await flushPromises();

			expect(optimisticallyMarkJoined).not.toHaveBeenCalled();
			expect(hierarchy.joinState("!room:x")).toBe("idle");
		});
	});
});
