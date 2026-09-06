import type { MatrixClient, RoomMember } from "matrix-js-sdk";
import { RoomMemberEvent, RoomStateEvent } from "matrix-js-sdk";
import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { createMockClient, createMockRoom } from "../../test/mockClient";
import {
	buildEntry,
	groupMembers,
	type MemberEntry,
	partitionByPresence,
	roleForPowerLevel,
	useMemberList,
} from "./useMemberList";

function requireAt<T>(items: readonly T[], index: number): T {
	const item = items[index];
	if (item === undefined) {
		throw new Error(
			`Expected item at index ${index}; received ${items.length} items`,
		);
	}
	return item;
}

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
		const admins = requireAt(groups, 0);
		const moderators = requireAt(groups, 1);
		const members = requireAt(groups, 2);
		expect(admins.role).toBe("Admin");
		expect(admins.members).toHaveLength(1);
		expect(moderators.role).toBe("Moderator");
		expect(moderators.members).toHaveLength(1);
		expect(members.role).toBe("Member");
		expect(members.members).toHaveLength(2);
		expect(requireAt(members.members, 0).displayName).toBe("Alice");
		expect(requireAt(members.members, 1).displayName).toBe("Bob");
	});

	it("omits empty groups", () => {
		const entries = [
			makeMember("@alice:x", "Alice", 0),
			makeMember("@bob:x", "Bob", 0),
		];

		const groups = groupMembers(entries);
		expect(groups).toHaveLength(1);
		expect(requireAt(groups, 0).role).toBe("Member");
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
		const member = requireAt(room.getJoinedMembers(), 0);

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
		const member = requireAt(room.getJoinedMembers(), 0);

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
		const member = requireAt(room.getJoinedMembers(), 0);

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
		const member = requireAt(room.getJoinedMembers(), 0);

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
		expect(requireAt(joined, 0).userId).toBe("@joined:x");
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
			const currentGroups = groups();
			expect(currentGroups.length).toBe(2);
			expect(requireAt(currentGroups, 0).role).toBe("Admin");
			expect(requireAt(currentGroups, 1).role).toBe("Member");
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
				const initialGroups = groups();
				expect(initialGroups).toHaveLength(1);
				const initialMembers = requireAt(initialGroups, 0).members;
				expect(initialMembers).toHaveLength(1);
				expect(requireAt(initialMembers, 0).isTyping).toBe(false);

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
				const refreshedGroups = groups();
				expect(refreshedGroups).toHaveLength(1);
				const refreshedMembers = requireAt(refreshedGroups, 0).members;
				expect(refreshedMembers).toHaveLength(1);
				expect(requireAt(refreshedMembers, 0).isTyping).toBe(true);
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

				// Reset rAF stub to track post-dispose calls
				let postDisposeRafCalled = false;
				globalThis.requestAnimationFrame = () => {
					postDisposeRafCalled = true;
					return 99;
				};

				// Emit after dispose — listeners should be removed
				client.__emit(
					RoomStateEvent.Members,
					{},
					{},
					{
						userId: "@alice:x",
						roomId: "!room:x",
					},
				);

				// No rAF should have been scheduled
				expect(postDisposeRafCalled).toBe(false);
			});
		} finally {
			globalThis.requestAnimationFrame = originalRAF;
			globalThis.cancelAnimationFrame = originalCAF;
		}
	});
});

describe("buildEntry display names", () => {
	const member = (name: string): RoomMember =>
		({
			userId: "@a:x",
			name,
			powerLevel: 0,
			typing: false,
			getMxcAvatarUrl: () => null,
		}) as unknown as RoomMember;

	const entryFor = (name: string): string =>
		buildEntry(member(name), createMockClient() as unknown as MatrixClient)
			.displayName;

	// `RoomMember.name` arrives with Element's whole policy already applied -
	// direction overrides stripped, the user ID substituted when nothing
	// renders, and `(@user:server)` appended when the name is suspicious or
	// collides. buildEntry's job is not to undo any of it - though the
	// policy's bidi strip is wider than the SDK's, so the output is not
	// always byte-equal to the input.

	it("passes the SDK's name through verbatim", () => {
		expect(entryFor("Ann Smith")).toBe("Ann Smith");
	});

	it("keeps the disambiguating suffix the SDK attached", () => {
		// The important one. A bidi character makes the SDK append the MXID,
		// which is precisely the signal that this name may be impersonating
		// someone. An earlier revision rejected such names wholesale and
		// rendered the bare MXID, throwing that signal away; a later one
		// truncated over-length names, which cut the suffix off the end.
		// The scope control itself is stripped (#575) - the SDK has already
		// appended the suffix by the time the name reaches the helper, so the
		// signal stays and only the formatting character goes.
		const disambiguated = `Ann${String.fromCharCode(0x202a)}Smith (@a:x)`;
		expect(entryFor(disambiguated)).toBe("AnnSmith (@a:x)");
	});

	it("keeps the invisible characters real names need", () => {
		// Not filtered, deliberately: ZWJ and friends are load-bearing in
		// several scripts and in every multi-part emoji, so barring them
		// breaks real names. The MXID answers impersonation, not a filter.
		for (const name of [
			`A${String.fromCharCode(0x200b)}dmin`,
			`A${String.fromCharCode(0x200d)}dmin`,
		]) {
			expect(entryFor(name)).toBe(name);
		}
	});

	it("falls back on a control character", () => {
		// This name reaches `memberRowLabel`'s aria-label and MembersTab's
		// kick/ban copy, and C0 is the one invisible class the SDK does not
		// normalize - so it collides with nothing and earns no (@mxid)
		// suffix.
		expect(entryFor(`Ann\nSmith`)).toBe("@a:x");
	});

	it("falls back when nothing visible renders", () => {
		// A name of two Hangul fillers rendered a blank row, a blank avatar
		// initial, and "View profile of " with nothing after it.
		expect(entryFor(String.fromCharCode(0x3164).repeat(2))).toBe("@a:x");
	});

	it("bounds the length, which is the one thing the SDK does not", () => {
		// The reason this path routes through displayNameOr at all. It
		// rebuilds for every member on every membership and typing event and
		// re-sorts each role section with localeCompare, and `displayname` is
		// unbounded on the wire - Conduwuity does not cap it.
		expect(entryFor("a".repeat(2000))).toBe("@a:x");
	});

	it("trims surrounding whitespace", () => {
		// `calculateDisplayName` returns the name untrimmed whenever anything
		// survives its hidden-character check, so padding does reach this row.
		expect(entryFor("  Ann Smith  ")).toBe("Ann Smith");
	});

	it("falls back to the user ID when the SDK gave nothing", () => {
		expect(entryFor("   ")).toBe("@a:x");
		expect(entryFor("")).toBe("@a:x");
	});
});

describe("partitionByPresence ordering", () => {
	const entry = (displayName: string): MemberEntry =>
		({ userId: `@${displayName.toLowerCase()}:x`, displayName }) as MemberEntry;

	it("interleaves the offline section across roles", () => {
		// Filled role-by-role, so without the merge it reads
		// admins-then-members - an order whose reason is off screen once
		// they share one section.
		const groups = [
			{ role: "Admin" as const, members: [entry("Ana"), entry("Zoe")] },
			{ role: "Member" as const, members: [entry("Bob"), entry("Yan")] },
		];
		const out = partitionByPresence(groups, () => "offline");
		expect(out).toHaveLength(1);
		const offline = requireAt(out, 0);
		expect(offline.role).toBe("Offline");
		expect(offline.members.map((m) => m.displayName)).toEqual([
			"Ana",
			"Bob",
			"Yan",
			"Zoe",
		]);
	});

	it("keeps every member when the runs are uneven", () => {
		// A merge that drains one run early is the classic way to lose the
		// tail of another.
		const groups = [
			{ role: "Admin" as const, members: [entry("Ann")] },
			{
				role: "Member" as const,
				members: [entry("Bea"), entry("Cal"), entry("Dee")],
			},
		];
		const out = partitionByPresence(groups, () => "offline");
		expect(out).toHaveLength(1);
		expect(requireAt(out, 0).members.map((m) => m.displayName)).toEqual([
			"Ann",
			"Bea",
			"Cal",
			"Dee",
		]);
	});
});
