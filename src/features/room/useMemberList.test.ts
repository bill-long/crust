import type { MatrixClient, RoomMember } from "matrix-js-sdk";
import { RoomMemberEvent, RoomStateEvent } from "matrix-js-sdk";
import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { createMockClient, createMockRoom } from "../../test/mockClient";
import {
	buildEntry,
	groupMembers,
	type MemberEntry,
	roleForPowerLevel,
	useMemberList,
} from "./useMemberList";

describe("roleForPowerLevel", () => {
	it("returns Admin for powerLevel >= 100", () => {
		expect(roleForPowerLevel(100)).toBe("Admin");
		expect(roleForPowerLevel(200)).toBe("Admin");
	});

	it("returns Moderator for powerLevel >= 50 and < 100", () => {
		expect(roleForPowerLevel(50)).toBe("Moderator");
		expect(roleForPowerLevel(99)).toBe("Moderator");
	});

	it("returns Member for powerLevel < 50", () => {
		expect(roleForPowerLevel(0)).toBe("Member");
		expect(roleForPowerLevel(49)).toBe("Member");
	});
});

describe("groupMembers", () => {
	const makeMember = (
		userId: string,
		displayName: string,
		powerLevel: number,
	): MemberEntry => ({
		userId,
		displayName,
		avatarUrl: null,
		powerLevel,
		isTyping: false,
	});

	it("groups members by role and sorts alphabetically within groups", () => {
		const entries = [
			makeMember("@bob:x", "Bob", 0),
			makeMember("@admin:x", "Admin User", 100),
			makeMember("@alice:x", "Alice", 0),
			makeMember("@mod:x", "Mod User", 50),
		];

		const groups = groupMembers(entries);
		expect(groups).toHaveLength(3);
		expect(groups[0].role).toBe("Admin");
		expect(groups[0].members).toHaveLength(1);
		expect(groups[1].role).toBe("Moderator");
		expect(groups[1].members).toHaveLength(1);
		expect(groups[2].role).toBe("Member");
		expect(groups[2].members).toHaveLength(2);
		expect(groups[2].members[0].displayName).toBe("Alice");
		expect(groups[2].members[1].displayName).toBe("Bob");
	});

	it("omits empty groups", () => {
		const entries = [
			makeMember("@alice:x", "Alice", 0),
			makeMember("@bob:x", "Bob", 0),
		];

		const groups = groupMembers(entries);
		expect(groups).toHaveLength(1);
		expect(groups[0].role).toBe("Member");
	});

	it("returns empty array for empty input", () => {
		expect(groupMembers([])).toEqual([]);
	});
});

describe("buildEntry", () => {
	it("builds entry from a mock member with avatar", () => {
		const client = createMockClient();
		const room = createMockRoom(
			"!room:x",
			[],
			[
				{
					userId: "@alice:x",
					name: "Alice",
					powerLevel: 50,
					avatarUrl: "mxc://example.com/avatar",
				},
			],
		);
		const member = room.getJoinedMembers()[0];

		const entry = buildEntry(
			member as unknown as RoomMember,
			client as unknown as MatrixClient,
		);
		expect(entry.userId).toBe("@alice:x");
		expect(entry.displayName).toBe("Alice");
		expect(entry.powerLevel).toBe(50);
		expect(entry.avatarUrl).toContain("example.com");
		expect(entry.isTyping).toBe(false);
	});

	it("uses userId as displayName when name is empty", () => {
		const client = createMockClient();
		const room = createMockRoom(
			"!room:x",
			[],
			[{ userId: "@noname:x", name: "" }],
		);
		const member = room.getJoinedMembers()[0];

		const entry = buildEntry(
			member as unknown as RoomMember,
			client as unknown as MatrixClient,
		);
		expect(entry.displayName).toBe("@noname:x");
	});

	it("returns null avatarUrl when member has no avatar", () => {
		const client = createMockClient();
		const room = createMockRoom(
			"!room:x",
			[],
			[{ userId: "@noavatar:x", name: "No Avatar" }],
		);
		const member = room.getJoinedMembers()[0];

		const entry = buildEntry(
			member as unknown as RoomMember,
			client as unknown as MatrixClient,
		);
		expect(entry.avatarUrl).toBeNull();
	});

	it("reflects typing state", () => {
		const client = createMockClient();
		const room = createMockRoom(
			"!room:x",
			[],
			[{ userId: "@typist:x", name: "Typist", typing: true }],
		);
		const member = room.getJoinedMembers()[0];

		const entry = buildEntry(
			member as unknown as RoomMember,
			client as unknown as MatrixClient,
		);
		expect(entry.isTyping).toBe(true);
	});
});

describe("getJoinedMembers filtering", () => {
	it("only returns members with join membership", () => {
		const room = createMockRoom(
			"!room:x",
			[],
			[
				{ userId: "@joined:x", name: "Joined", membership: "join" },
				{ userId: "@left:x", name: "Left", membership: "leave" },
				{ userId: "@invited:x", name: "Invited", membership: "invite" },
			],
		);

		const joined = room.getJoinedMembers();
		expect(joined).toHaveLength(1);
		expect(joined[0].userId).toBe("@joined:x");
	});
});

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

describe("useMemberList hook", () => {
	it("loads grouped members for initial room", async () => {
		const room = createMockRoom(
			"!room:x",
			[],
			[
				{ userId: "@alice:x", name: "Alice", powerLevel: 100 },
				{ userId: "@bob:x", name: "Bob", powerLevel: 0 },
			],
		);
		const client = createMockClient(new Map([["!room:x", room]]));

		await withRoot(async () => {
			const { groups, memberCount, loading } = useMemberList(
				client as unknown as MatrixClient,
				() => "!room:x",
			);

			await flushPromises();
			expect(loading()).toBe(false);
			expect(memberCount()).toBe(2);
			expect(groups().length).toBe(2);
			expect(groups()[0].role).toBe("Admin");
			expect(groups()[1].role).toBe("Member");
		});
	});

	it("updates when roomId signal changes", async () => {
		const roomA = createMockRoom(
			"!a:x",
			[],
			[{ userId: "@alice:x", name: "Alice" }],
		);
		const roomB = createMockRoom(
			"!b:x",
			[],
			[
				{ userId: "@bob:x", name: "Bob" },
				{ userId: "@carol:x", name: "Carol" },
			],
		);
		const client = createMockClient(
			new Map([
				["!a:x", roomA],
				["!b:x", roomB],
			]),
		);

		await withRoot(async () => {
			const [roomId, setRoomId] = createSignal("!a:x");
			const { memberCount } = useMemberList(
				client as unknown as MatrixClient,
				roomId,
			);

			await flushPromises();
			expect(memberCount()).toBe(1);

			setRoomId("!b:x");
			await flushPromises();
			expect(memberCount()).toBe(2);
		});
	});

	it("returns empty for unknown room", async () => {
		const client = createMockClient(new Map());

		await withRoot(async () => {
			const { groups, memberCount, loading } = useMemberList(
				client as unknown as MatrixClient,
				() => "!unknown:x",
			);

			await flushPromises();
			expect(loading()).toBe(false);
			expect(memberCount()).toBe(0);
			expect(groups()).toEqual([]);
		});
	});

	it("refreshes on member state event via rAF", async () => {
		const room = createMockRoom(
			"!room:x",
			[],
			[{ userId: "@alice:x", name: "Alice" }],
		);
		const client = createMockClient(new Map([["!room:x", room]]));

		let rafCallback: FrameRequestCallback | null = null;
		const originalRAF = globalThis.requestAnimationFrame;
		globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
			rafCallback = cb;
			return 1;
		};

		try {
			await withRoot(async () => {
				const { memberCount } = useMemberList(
					client as unknown as MatrixClient,
					() => "!room:x",
				);

				await flushPromises();
				expect(memberCount()).toBe(1);

				// Add a new member via mock helper
				room.__addMember({ userId: "@bob:x", name: "Bob" });

				// Emit member state change
				client.__emit(
					RoomStateEvent.Members,
					{},
					{},
					{
						userId: "@bob:x",
						roomId: "!room:x",
					},
				);

				expect(rafCallback).not.toBeNull();
				rafCallback?.(0);
				rafCallback = null;

				await flushPromises();
				expect(memberCount()).toBe(2);
			});
		} finally {
			globalThis.requestAnimationFrame = originalRAF;
		}
	});

	it("refreshes on typing event via rAF", async () => {
		const room = createMockRoom(
			"!room:x",
			[],
			[{ userId: "@alice:x", name: "Alice" }],
		);
		const client = createMockClient(new Map([["!room:x", room]]));

		let rafCallback: FrameRequestCallback | null = null;
		const originalRAF = globalThis.requestAnimationFrame;
		globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
			rafCallback = cb;
			return 1;
		};

		try {
			await withRoot(async () => {
				const { groups } = useMemberList(
					client as unknown as MatrixClient,
					() => "!room:x",
				);

				await flushPromises();
				expect(groups()[0].members[0].isTyping).toBe(false);

				room.__setTyping("@alice:x", true);

				client.__emit(
					RoomMemberEvent.Typing,
					{},
					{
						userId: "@alice:x",
						roomId: "!room:x",
					},
				);

				expect(rafCallback).not.toBeNull();
				rafCallback?.(0);
				rafCallback = null;

				await flushPromises();
				expect(groups()[0].members[0].isTyping).toBe(true);
			});
		} finally {
			globalThis.requestAnimationFrame = originalRAF;
		}
	});

	it("ignores events for other rooms", async () => {
		const room = createMockRoom(
			"!room:x",
			[],
			[{ userId: "@alice:x", name: "Alice" }],
		);
		const client = createMockClient(new Map([["!room:x", room]]));

		let rafCallback: FrameRequestCallback | null = null;
		const originalRAF = globalThis.requestAnimationFrame;
		globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
			rafCallback = cb;
			return 1;
		};

		try {
			await withRoot(async () => {
				useMemberList(client as unknown as MatrixClient, () => "!room:x");

				await flushPromises();

				client.__emit(
					RoomStateEvent.Members,
					{},
					{},
					{
						userId: "@bob:x",
						roomId: "!other:x",
					},
				);

				expect(rafCallback).toBeNull();
			});
		} finally {
			globalThis.requestAnimationFrame = originalRAF;
		}
	});

	it("coalesces multiple events into one rAF refresh", async () => {
		const room = createMockRoom(
			"!room:x",
			[],
			[{ userId: "@alice:x", name: "Alice" }],
		);
		const client = createMockClient(new Map([["!room:x", room]]));

		let rafCallCount = 0;
		const originalRAF = globalThis.requestAnimationFrame;
		globalThis.requestAnimationFrame = (_cb: FrameRequestCallback) => {
			rafCallCount++;
			return 1;
		};

		try {
			await withRoot(async () => {
				useMemberList(client as unknown as MatrixClient, () => "!room:x");

				await flushPromises();

				const member = { userId: "@alice:x", roomId: "!room:x" };

				for (let i = 0; i < 5; i++) {
					client.__emit(RoomStateEvent.Members, {}, {}, member);
				}

				expect(rafCallCount).toBe(1);
			});
		} finally {
			globalThis.requestAnimationFrame = originalRAF;
		}
	});

	it("removes listeners and cancels pending rAF on cleanup", async () => {
		const room = createMockRoom(
			"!room:x",
			[],
			[{ userId: "@alice:x", name: "Alice" }],
		);
		const client = createMockClient(new Map([["!room:x", room]]));

		const cancelledFrames: number[] = [];
		const originalRAF = globalThis.requestAnimationFrame;
		const originalCAF = globalThis.cancelAnimationFrame;
		globalThis.requestAnimationFrame = () => 42;
		globalThis.cancelAnimationFrame = (id: number) => {
			cancelledFrames.push(id);
		};

		try {
			await withRoot(async (dispose) => {
				useMemberList(client as unknown as MatrixClient, () => "!room:x");

				await flushPromises();

				// Schedule a refresh (creates pending rAF)
				client.__emit(
					RoomStateEvent.Members,
					{},
					{},
					{
						userId: "@alice:x",
						roomId: "!room:x",
					},
				);

				// Dispose before rAF fires
				dispose();

				// Pending frame should have been cancelled
				expect(cancelledFrames).toContain(42);
			});
		} finally {
			globalThis.requestAnimationFrame = originalRAF;
			globalThis.cancelAnimationFrame = originalCAF;
		}
	});
});
