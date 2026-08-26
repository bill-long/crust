import { describe, expect, it } from "vitest";
import type { RoomSummary, SummariesStore } from "./summaries";
import {
	flattenSpaceTree,
	getDmRooms,
	getFavoriteRooms,
	getForwardableRooms,
	getHomeUnreadRollup,
	getInvitedRoomCount,
	getInvitedRooms,
	getInvitedSpaces,
	getKnockedRooms,
	getKnockedSpaces,
	getLowPriorityHomeRooms,
	getOrphanRooms,
	getSpaceInvitedRooms,
	getSpaceKnockedRooms,
	getSpaceSubspaces,
	getSpaceTree,
	getSpaceUnreadRollup,
	getTotalUnread,
	MAX_SIDEBAR_SPACE_DEPTH,
} from "./summaries-selectors";

function room(partial: Partial<RoomSummary> & { roomId: string }): RoomSummary {
	return {
		name: partial.roomId,
		avatarUrl: null,
		lastMessage: null,
		unreadCount: 0,
		highlightCount: 0,
		markedUnread: false,
		isFavourite: false,
		isLowPriority: false,
		spaceOrder: null,
		isMuted: false,
		membership: "join",
		isEncrypted: false,
		isDirect: false,
		isSpace: false,
		kind: "text",
		callActive: false,
		children: [],
		...partial,
	};
}

function store(rooms: RoomSummary[]): SummariesStore {
	const s: SummariesStore = {};
	for (const r of rooms) s[r.roomId] = r;
	return s;
}

describe("getHomeUnreadRollup", () => {
	it("returns zero when there are no home rooms", () => {
		expect(getHomeUnreadRollup(store([]))).toEqual({
			unread: 0,
			highlight: 0,
			markedUnread: false,
		});
	});

	it("sums unread and highlight across DMs and orphan rooms", () => {
		const s = store([
			room({
				roomId: "!dm1",
				isDirect: true,
				unreadCount: 2,
				highlightCount: 1,
			}),
			room({ roomId: "!dm2", isDirect: true, unreadCount: 3 }),
			room({ roomId: "!orphan", unreadCount: 4, highlightCount: 2 }),
		]);
		expect(getHomeUnreadRollup(s)).toEqual({
			unread: 9,
			highlight: 3,
			markedUnread: false,
		});
	});

	it("excludes spaces and space-child rooms (counted under their space)", () => {
		const s = store([
			room({ roomId: "!space", isSpace: true, children: ["!child"] }),
			room({ roomId: "!child", unreadCount: 5, highlightCount: 1 }),
			room({ roomId: "!dm", isDirect: true, unreadCount: 1 }),
		]);
		// Only the DM counts; the space itself and its child are excluded.
		expect(getHomeUnreadRollup(s)).toEqual({
			unread: 1,
			highlight: 0,
			markedUnread: false,
		});
	});

	it("excludes rooms the user has not joined", () => {
		const s = store([
			room({
				roomId: "!invited",
				isDirect: true,
				membership: "invite",
				unreadCount: 9,
			}),
			room({ roomId: "!left", membership: "leave", unreadCount: 9 }),
			room({ roomId: "!dm", isDirect: true, unreadCount: 2 }),
		]);
		expect(getHomeUnreadRollup(s)).toEqual({
			unread: 2,
			highlight: 0,
			markedUnread: false,
		});
	});

	it("flags markedUnread when any home room is explicitly marked", () => {
		const s = store([
			room({ roomId: "!dm", isDirect: true, markedUnread: true }),
		]);
		expect(getHomeUnreadRollup(s)).toEqual({
			unread: 0,
			highlight: 0,
			markedUnread: true,
		});
	});

	it("does not flag markedUnread for a marked room that belongs to a space", () => {
		const s = store([
			room({ roomId: "!space", isSpace: true, children: ["!child"] }),
			room({ roomId: "!child", markedUnread: true }),
		]);
		expect(getHomeUnreadRollup(s).markedUnread).toBe(false);
	});
});

describe("getInvitedRooms", () => {
	it("returns only non-space rooms with a pending invite, sorted by name", () => {
		const s = store([
			room({ roomId: "!joined" }),
			room({ roomId: "!b", name: "beta", membership: "invite" }),
			room({ roomId: "!a", name: "alpha", membership: "invite" }),
			room({
				roomId: "!space",
				name: "zeta",
				isSpace: true,
				membership: "invite",
			}),
			room({ roomId: "!left", membership: "leave" }),
		]);
		expect(getInvitedRooms(s).map((r) => r.roomId)).toEqual(["!a", "!b"]);
	});

	it("includes invited DMs and invited space-child rooms", () => {
		const s = store([
			room({ roomId: "!space", isSpace: true, children: ["!child"] }),
			room({ roomId: "!child", membership: "invite" }),
			room({ roomId: "!dm", isDirect: true, membership: "invite" }),
		]);
		expect(getInvitedRooms(s).map((r) => r.roomId)).toEqual(["!child", "!dm"]);
	});
});

describe("getInvitedRoomCount", () => {
	it("matches getInvitedRooms().length", () => {
		const s = store([
			room({ roomId: "!joined" }),
			room({ roomId: "!a", membership: "invite" }),
			room({ roomId: "!dm", isDirect: true, membership: "invite" }),
			room({ roomId: "!space", isSpace: true, membership: "invite" }),
			room({ roomId: "!left", membership: "leave" }),
		]);
		expect(getInvitedRoomCount(s)).toBe(getInvitedRooms(s).length);
		expect(getInvitedRoomCount(s)).toBe(2);
		expect(getInvitedRoomCount(store([]))).toBe(0);
	});
});

describe("getInvitedSpaces", () => {
	it("returns only spaces with a pending invite, sorted by name", () => {
		const s = store([
			room({ roomId: "!joinedSpace", isSpace: true }),
			room({
				roomId: "!s2",
				name: "beta",
				isSpace: true,
				membership: "invite",
			}),
			room({
				roomId: "!s1",
				name: "alpha",
				isSpace: true,
				membership: "invite",
			}),
			room({ roomId: "!room", membership: "invite" }),
		]);
		expect(getInvitedSpaces(s).map((r) => r.roomId)).toEqual(["!s1", "!s2"]);
	});
});

describe("getSpaceInvitedRooms", () => {
	it("returns pending invites among a joined space's children", () => {
		const s = store([
			room({
				roomId: "!space",
				isSpace: true,
				children: ["!b", "!a", "!joined", "!subspace"],
			}),
			room({ roomId: "!b", name: "beta", membership: "invite" }),
			room({ roomId: "!a", name: "alpha", membership: "invite" }),
			room({ roomId: "!joined" }),
			room({ roomId: "!subspace", isSpace: true, membership: "invite" }),
			room({ roomId: "!elsewhere", membership: "invite" }),
		]);
		expect(getSpaceInvitedRooms(s, "!space").map((r) => r.roomId)).toEqual([
			"!a",
			"!b",
		]);
	});

	it("returns empty for a space the user has not joined", () => {
		const s = store([
			room({
				roomId: "!space",
				isSpace: true,
				membership: "invite",
				children: ["!child"],
			}),
			room({ roomId: "!child", membership: "invite" }),
		]);
		expect(getSpaceInvitedRooms(s, "!space")).toEqual([]);
	});
});

describe("getKnockedRooms", () => {
	it("returns non-space knocked rooms sorted by name, including space children", () => {
		const s = store([
			room({ roomId: "!space", isSpace: true, children: ["!child"] }),
			room({ roomId: "!b", name: "beta", membership: "knock" }),
			room({ roomId: "!a", name: "alpha", membership: "knock" }),
			room({ roomId: "!child", name: "child room", membership: "knock" }),
			room({ roomId: "!joined" }),
			room({ roomId: "!invited", membership: "invite" }),
			room({ roomId: "!knockspace", isSpace: true, membership: "knock" }),
		]);
		expect(getKnockedRooms(s).map((r) => r.roomId)).toEqual([
			"!a",
			"!b",
			"!child",
		]);
	});
});

describe("getSpaceKnockedRooms", () => {
	it("returns pending knocks among a joined space's children", () => {
		const s = store([
			room({
				roomId: "!space",
				isSpace: true,
				children: ["!b", "!a", "!joined"],
			}),
			room({ roomId: "!b", name: "beta", membership: "knock" }),
			room({ roomId: "!a", name: "alpha", membership: "knock" }),
			room({ roomId: "!joined" }),
			room({ roomId: "!elsewhere", membership: "knock" }),
		]);
		expect(getSpaceKnockedRooms(s, "!space").map((r) => r.roomId)).toEqual([
			"!a",
			"!b",
		]);
	});

	it("returns empty for a space the user has not joined", () => {
		const s = store([
			room({
				roomId: "!space",
				isSpace: true,
				membership: "invite",
				children: ["!child"],
			}),
			room({ roomId: "!child", membership: "knock" }),
		]);
		expect(getSpaceKnockedRooms(s, "!space")).toEqual([]);
	});
});

describe("getKnockedSpaces", () => {
	it("returns knocked spaces sorted by name", () => {
		const s = store([
			room({ roomId: "!s2", isSpace: true, name: "zeta", membership: "knock" }),
			room({
				roomId: "!s1",
				isSpace: true,
				name: "alpha",
				membership: "knock",
			}),
			room({ roomId: "!joined-space", isSpace: true }),
			room({ roomId: "!knock-room", membership: "knock" }),
			room({ roomId: "!invited-space", isSpace: true, membership: "invite" }),
		]);
		expect(getKnockedSpaces(s).map((r) => r.roomId)).toEqual(["!s1", "!s2"]);
	});
});

describe("getTotalUnread", () => {
	it("returns zero for an empty store", () => {
		expect(getTotalUnread(store([]))).toBe(0);
	});

	it("sums unread across all joined rooms, including space children", () => {
		const s = store([
			room({ roomId: "!space", isSpace: true, children: ["!child"] }),
			room({ roomId: "!child", unreadCount: 5 }),
			room({ roomId: "!dm", isDirect: true, unreadCount: 2 }),
			room({ roomId: "!orphan", unreadCount: 3 }),
		]);
		// Unlike getHomeUnreadRollup, the space child is counted here.
		expect(getTotalUnread(s)).toBe(10);
	});

	it("excludes spaces' own count and non-joined rooms", () => {
		const s = store([
			room({ roomId: "!space", isSpace: true, unreadCount: 7 }),
			room({ roomId: "!invited", membership: "invite", unreadCount: 9 }),
			room({ roomId: "!left", membership: "leave", unreadCount: 9 }),
			room({ roomId: "!dm", isDirect: true, unreadCount: 4 }),
		]);
		expect(getTotalUnread(s)).toBe(4);
	});
});

describe("getSpaceSubspaces (#443)", () => {
	it("returns joined space children sorted by name", () => {
		const s = store([
			room({
				roomId: "!space",
				isSpace: true,
				children: ["!zeta", "!alpha", "!room"],
			}),
			room({ roomId: "!zeta", isSpace: true, name: "Zeta" }),
			room({ roomId: "!alpha", isSpace: true, name: "Alpha" }),
			room({ roomId: "!room", name: "room" }),
		]);
		expect(getSpaceSubspaces(s, "!space").map((r) => r.roomId)).toEqual([
			"!alpha",
			"!zeta",
		]);
	});

	it("excludes subspaces the user has not joined", () => {
		const s = store([
			room({ roomId: "!space", isSpace: true, children: ["!sub"] }),
			room({ roomId: "!sub", isSpace: true, membership: "invite" }),
		]);
		expect(getSpaceSubspaces(s, "!space")).toEqual([]);
	});

	it("returns empty for a space the user has not joined or a non-space", () => {
		const s = store([
			room({
				roomId: "!space",
				isSpace: true,
				membership: "leave",
				children: ["!sub"],
			}),
			room({ roomId: "!sub", isSpace: true }),
			room({ roomId: "!plain", children: ["!sub"] }),
		]);
		expect(getSpaceSubspaces(s, "!space")).toEqual([]);
		expect(getSpaceSubspaces(s, "!plain")).toEqual([]);
		expect(getSpaceSubspaces(s, "!unknown")).toEqual([]);
	});
});

describe("getSpaceUnreadRollup recursion (#443)", () => {
	it("sums direct joined child rooms (pre-existing behavior)", () => {
		const s = store([
			room({
				roomId: "!space",
				isSpace: true,
				children: ["!a", "!b", "!invited"],
			}),
			room({ roomId: "!a", unreadCount: 2, highlightCount: 1 }),
			room({ roomId: "!b", unreadCount: 3 }),
			room({ roomId: "!invited", membership: "invite", unreadCount: 9 }),
		]);
		expect(getSpaceUnreadRollup(s, "!space")).toEqual({
			unread: 5,
			highlight: 1,
			markedUnread: false,
		});
	});

	it("rolls up rooms of joined subspaces recursively", () => {
		const s = store([
			room({ roomId: "!space", isSpace: true, children: ["!sub", "!a"] }),
			room({
				roomId: "!sub",
				isSpace: true,
				children: ["!grandchild"],
			}),
			room({ roomId: "!grandchild", unreadCount: 4, highlightCount: 2 }),
			room({ roomId: "!a", unreadCount: 1 }),
		]);
		expect(getSpaceUnreadRollup(s, "!space")).toEqual({
			unread: 5,
			highlight: 2,
			markedUnread: false,
		});
		// The subspace's own rollup is just its subtree.
		expect(getSpaceUnreadRollup(s, "!sub")).toEqual({
			unread: 4,
			highlight: 2,
			markedUnread: false,
		});
	});

	it("does not descend into subspaces the user has not joined", () => {
		const s = store([
			room({ roomId: "!space", isSpace: true, children: ["!sub"] }),
			room({
				roomId: "!sub",
				isSpace: true,
				membership: "invite",
				children: ["!grandchild"],
			}),
			room({ roomId: "!grandchild", unreadCount: 4 }),
		]);
		expect(getSpaceUnreadRollup(s, "!space")).toEqual({
			unread: 0,
			highlight: 0,
			markedUnread: false,
		});
	});

	it("is cycle-safe: an A<->B space loop counts each room once and terminates", () => {
		const s = store([
			room({ roomId: "!a", isSpace: true, children: ["!b", "!ra"] }),
			room({ roomId: "!b", isSpace: true, children: ["!a", "!rb"] }),
			room({ roomId: "!ra", unreadCount: 2 }),
			room({ roomId: "!rb", unreadCount: 3 }),
		]);
		expect(getSpaceUnreadRollup(s, "!a")).toEqual({
			unread: 5,
			highlight: 0,
			markedUnread: false,
		});
	});

	it("is self-reference safe", () => {
		const s = store([
			room({ roomId: "!a", isSpace: true, children: ["!a", "!r"] }),
			room({ roomId: "!r", unreadCount: 1 }),
		]);
		expect(getSpaceUnreadRollup(s, "!a")).toEqual({
			unread: 1,
			highlight: 0,
			markedUnread: false,
		});
	});

	it("flags markedUnread when any descendant room is explicitly marked", () => {
		const s = store([
			room({ roomId: "!space", isSpace: true, children: ["!sub"] }),
			room({ roomId: "!sub", isSpace: true, children: ["!grandchild"] }),
			room({ roomId: "!grandchild", markedUnread: true }),
		]);
		expect(getSpaceUnreadRollup(s, "!space")).toEqual({
			unread: 0,
			highlight: 0,
			markedUnread: true,
		});
	});

	it("counts a shared room once when two subspaces list it (diamond)", () => {
		const s = store([
			room({ roomId: "!space", isSpace: true, children: ["!x", "!y"] }),
			room({ roomId: "!x", isSpace: true, children: ["!shared"] }),
			room({ roomId: "!y", isSpace: true, children: ["!shared"] }),
			room({ roomId: "!shared", unreadCount: 7 }),
		]);
		expect(getSpaceUnreadRollup(s, "!space")).toEqual({
			unread: 7,
			highlight: 0,
			markedUnread: false,
		});
	});
});

describe("getSpaceTree (#443)", () => {
	it("nests joined subspaces under their parent, name-sorted", () => {
		const s = store([
			room({
				roomId: "!root",
				isSpace: true,
				name: "Root",
				children: ["!zeta", "!alpha"],
			}),
			room({ roomId: "!zeta", isSpace: true, name: "Zeta" }),
			room({ roomId: "!alpha", isSpace: true, name: "Alpha" }),
			room({ roomId: "!other", isSpace: true, name: "Other" }),
		]);
		const tree = getSpaceTree(s);
		expect(tree.map((n) => n.space.roomId)).toEqual(["!other", "!root"]);
		const root = tree.find((n) => n.space.roomId === "!root");
		expect(root?.children.map((n) => n.space.roomId)).toEqual([
			"!alpha",
			"!zeta",
		]);
	});

	it("orders roots by m.space_order before name; subspaces stay name-sorted (#449)", () => {
		const s = store([
			// Unordered roots fall back to name, after every ordered root.
			room({ roomId: "!anna", isSpace: true, name: "Anna" }),
			room({ roomId: "!zed", isSpace: true, name: "Zed", spaceOrder: "a" }),
			room({
				roomId: "!mid",
				isSpace: true,
				name: "Mid",
				spaceOrder: "b",
				// Child order is the parent's m.space.child state - a child's
				// own spaceOrder must NOT reorder it within the parent.
				children: ["!zeta-child", "!alpha-child"],
			}),
			room({
				roomId: "!zeta-child",
				isSpace: true,
				name: "Zeta",
				spaceOrder: "a",
			}),
			room({ roomId: "!alpha-child", isSpace: true, name: "Alpha" }),
		]);
		const tree = getSpaceTree(s);
		expect(tree.map((n) => n.space.roomId)).toEqual(["!zed", "!mid", "!anna"]);
		const mid = tree.find((n) => n.space.roomId === "!mid");
		expect(mid?.children.map((n) => n.space.roomId)).toEqual([
			"!alpha-child",
			"!zeta-child",
		]);
	});

	it("treats a subspace whose parent is not joined as a root", () => {
		const s = store([
			room({
				roomId: "!unjoined-parent",
				isSpace: true,
				membership: "leave",
				children: ["!sub"],
			}),
			room({ roomId: "!sub", isSpace: true, name: "Sub" }),
		]);
		const tree = getSpaceTree(s);
		expect(tree.map((n) => n.space.roomId)).toEqual(["!sub"]);
		expect(tree[0].children).toEqual([]);
	});

	it("places every cycle member exactly once (A<->B)", () => {
		const s = store([
			room({ roomId: "!a", isSpace: true, name: "A", children: ["!b"] }),
			room({ roomId: "!b", isSpace: true, name: "B", children: ["!a"] }),
		]);
		const flat = flattenSpaceTree(getSpaceTree(s));
		expect(flat.spaces.map((r) => r.roomId).sort()).toEqual(["!a", "!b"]);
		// A renders as a root with B nested; neither hangs nor loop-renders.
		expect(flat.spaces.filter((r) => r.roomId === "!a")).toHaveLength(1);
		expect(flat.spaces.filter((r) => r.roomId === "!b")).toHaveLength(1);
	});

	it("places a self-referencing space exactly once", () => {
		const s = store([
			room({ roomId: "!a", isSpace: true, name: "A", children: ["!a"] }),
		]);
		const flat = flattenSpaceTree(getSpaceTree(s));
		expect(flat.spaces).toHaveLength(1);
		expect(flat.depths.get("!a")).toBe(0);
	});

	it("places a shared subspace once when two parents claim it (diamond)", () => {
		const s = store([
			room({ roomId: "!a", isSpace: true, name: "A", children: ["!shared"] }),
			room({ roomId: "!b", isSpace: true, name: "B", children: ["!shared"] }),
			room({ roomId: "!shared", isSpace: true, name: "Shared" }),
		]);
		const flat = flattenSpaceTree(getSpaceTree(s));
		expect(flat.spaces.map((r) => r.roomId).sort()).toEqual([
			"!a",
			"!b",
			"!shared",
		]);
		expect(flat.depths.get("!shared")).toBe(1);
	});

	it("falls back to a root tile beyond the depth cap so nothing disappears", () => {
		// Chain !a -> !b -> !c -> !d: !d nests deeper than the cap.
		const s = store([
			room({ roomId: "!a", isSpace: true, name: "A", children: ["!b"] }),
			room({ roomId: "!b", isSpace: true, name: "B", children: ["!c"] }),
			room({ roomId: "!c", isSpace: true, name: "C", children: ["!d"] }),
			room({ roomId: "!d", isSpace: true, name: "D" }),
		]);
		const flat = flattenSpaceTree(getSpaceTree(s));
		expect(flat.spaces).toHaveLength(4);
		expect(flat.depths.get("!a")).toBe(0);
		expect(flat.depths.get("!b")).toBe(1);
		expect(flat.depths.get("!c")).toBe(MAX_SIDEBAR_SPACE_DEPTH);
		// D exceeds the cap: appended as a root so it stays reachable.
		expect(flat.depths.get("!d")).toBe(0);
	});

	it("ignores non-joined and non-space children when nesting", () => {
		const s = store([
			room({
				roomId: "!root",
				isSpace: true,
				name: "Root",
				children: ["!room", "!invited-sub", "!joined-sub"],
			}),
			room({ roomId: "!room", name: "room" }),
			room({
				roomId: "!invited-sub",
				isSpace: true,
				membership: "invite",
			}),
			room({ roomId: "!joined-sub", isSpace: true, name: "Joined Sub" }),
		]);
		const tree = getSpaceTree(s);
		expect(tree).toHaveLength(1);
		expect(tree[0].children.map((n) => n.space.roomId)).toEqual([
			"!joined-sub",
		]);
	});

	it("flattens depth-first in render order", () => {
		const s = store([
			room({
				roomId: "!root",
				isSpace: true,
				name: "Root",
				children: ["!sub"],
			}),
			room({
				roomId: "!sub",
				isSpace: true,
				name: "Sub",
				children: ["!grand"],
			}),
			room({ roomId: "!grand", isSpace: true, name: "Grand" }),
			room({ roomId: "!zzz", isSpace: true, name: "Zzz" }),
		]);
		const flat = flattenSpaceTree(getSpaceTree(s));
		expect(flat.spaces.map((r) => r.roomId)).toEqual([
			"!root",
			"!sub",
			"!grand",
			"!zzz",
		]);
		expect(flat.depths.get("!grand")).toBe(2);
	});
});

describe("getSpaceSubspaces self-reference guard (#443)", () => {
	it("excludes a space that lists itself as a child", () => {
		const s = store([
			room({
				roomId: "!space",
				isSpace: true,
				children: ["!space", "!sub"],
			}),
			room({ roomId: "!sub", isSpace: true, name: "Sub" }),
		]);
		expect(getSpaceSubspaces(s, "!space").map((r) => r.roomId)).toEqual([
			"!sub",
		]);
	});
});

describe("getSpaceTree / rollup wire-debris edges (#443)", () => {
	it("places and counts duplicate child ids in one children array only once", () => {
		const s = store([
			room({
				roomId: "!a",
				isSpace: true,
				name: "A",
				children: ["!r", "!r", "!sub", "!sub"],
			}),
			room({ roomId: "!sub", isSpace: true, name: "Sub" }),
			room({ roomId: "!r", unreadCount: 5 }),
		]);
		const flat = flattenSpaceTree(getSpaceTree(s));
		expect(flat.spaces.filter((r) => r.roomId === "!sub")).toHaveLength(1);
		expect(getSpaceUnreadRollup(s, "!a")).toEqual({
			unread: 5,
			highlight: 0,
			markedUnread: false,
		});
	});

	it("skips children missing from the store (unsynced child id)", () => {
		const s = store([
			room({
				roomId: "!a",
				isSpace: true,
				name: "A",
				children: ["!ghost", "!r"],
			}),
			room({ roomId: "!r", unreadCount: 1 }),
		]);
		const flat = flattenSpaceTree(getSpaceTree(s));
		expect(flat.spaces.map((r) => r.roomId)).toEqual(["!a"]);
		expect(getSpaceUnreadRollup(s, "!a")).toEqual({
			unread: 1,
			highlight: 0,
			markedUnread: false,
		});
	});
});

describe("getForwardableRooms", () => {
	it("returns joined non-space rooms sorted by name", () => {
		const s = store([
			room({ roomId: "!b:x", name: "beta" }),
			room({ roomId: "!a:x", name: "alpha" }),
			room({ roomId: "!dm:x", name: "carol", isDirect: true }),
		]);
		expect(getForwardableRooms(s).map((r) => r.roomId)).toEqual([
			"!a:x",
			"!b:x",
			"!dm:x",
		]);
	});

	it("excludes spaces and non-joined rooms", () => {
		const s = store([
			room({ roomId: "!r:x", name: "room" }),
			room({ roomId: "!space:x", name: "space", isSpace: true }),
			room({ roomId: "!inv:x", name: "invited", membership: "invite" }),
			room({ roomId: "!knock:x", name: "knocked", membership: "knock" }),
		]);
		expect(getForwardableRooms(s).map((r) => r.roomId)).toEqual(["!r:x"]);
	});
});

describe("room tag sections (#449)", () => {
	it("getFavoriteRooms includes DMs and space children, sorted by activity", () => {
		const s = store([
			room({ roomId: "!space", isSpace: true, children: ["!child"] }),
			room({
				roomId: "!child",
				isFavourite: true,
				lastMessage: { body: "x", sender: "@a", timestamp: 2 },
			}),
			room({
				roomId: "!dm",
				isDirect: true,
				isFavourite: true,
				lastMessage: { body: "x", sender: "@a", timestamp: 5 },
			}),
			room({ roomId: "!plain" }),
			room({ roomId: "!left", isFavourite: true, membership: "leave" }),
		]);
		expect(getFavoriteRooms(s).map((r) => r.roomId)).toEqual(["!dm", "!child"]);
	});

	it("tagged rooms leave the DM / Rooms sections", () => {
		const s = store([
			room({ roomId: "!dm", isDirect: true, isFavourite: true }),
			room({ roomId: "!dm2", isDirect: true }),
			room({ roomId: "!orphan", isLowPriority: true }),
			room({ roomId: "!orphan2" }),
		]);
		expect(getDmRooms(s).map((r) => r.roomId)).toEqual(["!dm2"]);
		expect(getOrphanRooms(s).map((r) => r.roomId)).toEqual(["!orphan2"]);
	});

	it("getLowPriorityHomeRooms sinks home rooms only, and favourite wins", () => {
		const s = store([
			room({ roomId: "!space", isSpace: true, children: ["!child"] }),
			room({ roomId: "!child", isLowPriority: true }),
			room({ roomId: "!dm", isDirect: true, isLowPriority: true }),
			room({ roomId: "!orphan", isLowPriority: true }),
			room({
				roomId: "!both",
				isLowPriority: true,
				isFavourite: true,
			}),
		]);
		expect(
			getLowPriorityHomeRooms(s)
				.map((r) => r.roomId)
				.sort(),
		).toEqual(["!dm", "!orphan"]);
		expect(getFavoriteRooms(s).map((r) => r.roomId)).toEqual(["!both"]);
	});
});
