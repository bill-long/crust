import { describe, expect, it } from "vitest";
import type { RoomSummary, SummariesStore } from "./summaries";
import {
	getHomeUnreadRollup,
	getInvitedRoomCount,
	getInvitedRooms,
	getInvitedSpaces,
	getSpaceInvitedRooms,
	getTotalUnread,
} from "./summaries-selectors";

function room(partial: Partial<RoomSummary> & { roomId: string }): RoomSummary {
	return {
		name: partial.roomId,
		avatarUrl: null,
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
		expect(getHomeUnreadRollup(store([]))).toEqual({ unread: 0, highlight: 0 });
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
		expect(getHomeUnreadRollup(s)).toEqual({ unread: 9, highlight: 3 });
	});

	it("excludes spaces and space-child rooms (counted under their space)", () => {
		const s = store([
			room({ roomId: "!space", isSpace: true, children: ["!child"] }),
			room({ roomId: "!child", unreadCount: 5, highlightCount: 1 }),
			room({ roomId: "!dm", isDirect: true, unreadCount: 1 }),
		]);
		// Only the DM counts; the space itself and its child are excluded.
		expect(getHomeUnreadRollup(s)).toEqual({ unread: 1, highlight: 0 });
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
		expect(getHomeUnreadRollup(s)).toEqual({ unread: 2, highlight: 0 });
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
