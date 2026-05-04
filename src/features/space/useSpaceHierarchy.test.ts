import type { HierarchyRoom } from "matrix-js-sdk";
import { createRoot, createSignal } from "solid-js";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SummariesStore } from "../../client/summaries";

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
	const summaries: SummariesStore = {};

	(useClient as Mock).mockReturnValue({ client: mockClient, summaries });

	return { mockClient, summaries };
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
});
