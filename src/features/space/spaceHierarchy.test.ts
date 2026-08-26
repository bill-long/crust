import type { HierarchyRoom } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import type { RoomSummary, SummariesStore } from "../../client/summaries";
import { extractViaServers, filterDiscoverableRooms } from "./spaceHierarchy";

function makeHierarchyRoom(
	overrides: Omit<Partial<HierarchyRoom>, "join_rule"> & {
		room_id: string;
		join_rule?: string;
	},
): HierarchyRoom {
	return {
		name: "name" in overrides ? overrides.name : overrides.room_id,
		avatar_url: overrides.avatar_url,
		topic: overrides.topic,
		canonical_alias: overrides.canonical_alias,
		aliases: overrides.aliases,
		world_readable: overrides.world_readable ?? false,
		guest_can_join: overrides.guest_can_join ?? false,
		num_joined_members: overrides.num_joined_members ?? 5,
		room_type: overrides.room_type,
		join_rule: overrides.join_rule as HierarchyRoom["join_rule"],
		children_state: overrides.children_state ?? [],
		room_id: overrides.room_id,
	};
}

function makeSummary(
	roomId: string,
	membership: string,
	isSpace = false,
): RoomSummary {
	return {
		roomId,
		name: roomId,
		avatarUrl: null,
		lastMessage: null,
		unreadCount: 0,
		highlightCount: 0,
		markedUnread: false,
		isFavourite: false,
		isLowPriority: false,
		membership,
		isEncrypted: false,
		isDirect: false,
		isSpace,
		kind: "text",
		callActive: false,
		children: [],
	};
}

const SPACE_ID = "!space:example.com";

const mockMxcToHttp = (mxcUrl: string): string | null =>
	mxcUrl.replace("mxc://", "https://example.com/_matrix/media/v3/download/");

describe("extractViaServers", () => {
	it("extracts via servers from children_state matching the child room", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({
				room_id: SPACE_ID,
				room_type: "m.space",
				children_state: [
					{
						type: "m.space.child",
						state_key: "!room1:example.com",
						content: { via: ["example.com", "other.com"] },
						sender: "@admin:example.com",
						origin_server_ts: 1000,
					},
					{
						type: "m.space.child",
						state_key: "!room2:example.com",
						content: { via: ["second.com"] },
						sender: "@admin:example.com",
						origin_server_ts: 1000,
					},
				],
			}),
		];

		expect(extractViaServers(rooms, SPACE_ID, "!room1:example.com")).toEqual([
			"example.com",
			"other.com",
		]);
		expect(extractViaServers(rooms, SPACE_ID, "!room2:example.com")).toEqual([
			"second.com",
		]);
	});

	it("returns empty array when child room not found in children_state", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({
				room_id: SPACE_ID,
				children_state: [
					{
						type: "m.space.child",
						state_key: "!room1:example.com",
						content: { via: ["example.com"] },
						sender: "@admin:example.com",
						origin_server_ts: 1000,
					},
				],
			}),
		];

		expect(extractViaServers(rooms, SPACE_ID, "!unknown:example.com")).toEqual(
			[],
		);
	});

	it("returns empty array when space not found in hierarchy", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: "!other:example.com" }),
		];
		expect(extractViaServers(rooms, SPACE_ID, "!room1:example.com")).toEqual(
			[],
		);
	});

	it("returns empty array when via is missing from children_state content", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({
				room_id: SPACE_ID,
				children_state: [
					{
						type: "m.space.child",
						state_key: "!room1:example.com",
						content: {},
						sender: "@admin:example.com",
						origin_server_ts: 1000,
					},
				],
			}),
		];
		expect(extractViaServers(rooms, SPACE_ID, "!room1:example.com")).toEqual(
			[],
		);
	});
});

describe("filterDiscoverableRooms", () => {
	it("excludes the space itself from results", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!room1:example.com",
				join_rule: "public",
			}),
		];
		const summaries: SummariesStore = {};

		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			mockMxcToHttp,
		);
		expect(result).toHaveLength(1);
		expect(result[0].roomId).toBe("!room1:example.com");
	});

	it("carries sub-spaces (room_type m.space) through with isSpace=true", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!subspace:example.com",
				room_type: "m.space",
				join_rule: "public",
			}),
			makeHierarchyRoom({
				room_id: "!room1:example.com",
				join_rule: "public",
			}),
		];
		const summaries: SummariesStore = {};

		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			mockMxcToHttp,
		);
		expect(result).toHaveLength(2);
		expect(result[0].roomId).toBe("!subspace:example.com");
		expect(result[0].isSpace).toBe(true);
		expect(result[0].canJoin).toBe(true);
		expect(result[1].roomId).toBe("!room1:example.com");
		expect(result[1].isSpace).toBe(false);
	});

	it("excludes joined, invited, and knocked subspaces (they render in the space view / sidebar)", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!joinedsub:example.com",
				room_type: "m.space",
				join_rule: "public",
			}),
			makeHierarchyRoom({
				room_id: "!invitedsub:example.com",
				room_type: "m.space",
				join_rule: "public",
			}),
			makeHierarchyRoom({
				room_id: "!knockedsub:example.com",
				room_type: "m.space",
				join_rule: "knock",
			}),
		];
		const summaries: SummariesStore = {
			"!joinedsub:example.com": makeSummary(
				"!joinedsub:example.com",
				"join",
				true,
			),
			"!invitedsub:example.com": makeSummary(
				"!invitedsub:example.com",
				"invite",
				true,
			),
			"!knockedsub:example.com": makeSummary(
				"!knockedsub:example.com",
				"knock",
				true,
			),
		};

		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			mockMxcToHttp,
		);
		expect(result).toEqual([]);
	});

	it("sets canKnock for knock-rule subspaces", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!knocksub:example.com",
				room_type: "m.space",
				join_rule: "knock",
			}),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, mockMxcToHttp);
		expect(result[0].isSpace).toBe(true);
		expect(result[0].canJoin).toBe(false);
		expect(result[0].canKnock).toBe(true);
	});

	it("excludes rooms the user has already joined", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!joined:example.com",
				join_rule: "public",
			}),
			makeHierarchyRoom({
				room_id: "!notjoined:example.com",
				join_rule: "public",
			}),
		];
		const summaries: SummariesStore = {
			"!joined:example.com": makeSummary("!joined:example.com", "join"),
		};

		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			mockMxcToHttp,
		);
		expect(result).toHaveLength(1);
		expect(result[0].roomId).toBe("!notjoined:example.com");
	});

	it("excludes invited rooms (they render in the Invites section) but keeps left rooms", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!invited:example.com",
				join_rule: "public",
			}),
			makeHierarchyRoom({
				room_id: "!left:example.com",
				join_rule: "public",
			}),
		];
		const summaries: SummariesStore = {
			"!invited:example.com": makeSummary("!invited:example.com", "invite"),
			"!left:example.com": makeSummary("!left:example.com", "leave"),
		};

		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			mockMxcToHttp,
		);
		expect(result).toHaveLength(1);
		expect(result[0].roomId).toBe("!left:example.com");
	});

	it("maps room fields correctly", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!room1:example.com",
				name: "General Chat",
				topic: "A place to chat",
				avatar_url: "mxc://example.com/abc123",
				num_joined_members: 42,
				join_rule: "public",
			}),
		];
		const summaries: SummariesStore = {};

		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			mockMxcToHttp,
		);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			roomId: "!room1:example.com",
			name: "General Chat",
			avatarUrl:
				"https://example.com/_matrix/media/v3/download/example.com/abc123",
			topic: "A place to chat",
			memberCount: 42,
			joinRule: "public",
			canJoin: true,
			canKnock: false,
			isSpace: false,
		});
	});

	it("falls back to canonical_alias then room_id for name", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!room1:example.com",
				name: undefined,
				canonical_alias: "#general:example.com",
				join_rule: "public",
			}),
			makeHierarchyRoom({
				room_id: "!room2:example.com",
				name: undefined,
				canonical_alias: undefined,
				join_rule: "public",
			}),
		];
		const summaries: SummariesStore = {};

		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			mockMxcToHttp,
		);
		expect(result[0].name).toBe("#general:example.com");
		expect(result[1].name).toBe("!room2:example.com");
	});

	it("treats empty or whitespace-only name as missing", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!empty:example.com",
				name: "",
				canonical_alias: "#fallback:example.com",
				join_rule: "public",
			}),
			makeHierarchyRoom({
				room_id: "!spaces:example.com",
				name: "   ",
				canonical_alias: undefined,
				join_rule: "public",
			}),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, mockMxcToHttp);
		expect(result[0].name).toBe("#fallback:example.com");
		expect(result[1].name).toBe("!spaces:example.com");
	});

	it("sets canJoin=true for public rooms", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!pub:example.com",
				join_rule: "public",
			}),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, mockMxcToHttp);
		expect(result[0].canJoin).toBe(true);
	});

	it("sets canJoin=false and canKnock=true for knock rooms", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!knock:example.com",
				join_rule: "knock",
			}),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, mockMxcToHttp);
		expect(result[0].canJoin).toBe(false);
		expect(result[0].canKnock).toBe(true);
	});

	it("sets canKnock for knock_restricted rooms based on parent-space membership", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!kr:example.com",
				join_rule: "knock_restricted",
			}),
		];
		const member: SummariesStore = {
			[SPACE_ID]: makeSummary(SPACE_ID, "join", true),
		};
		expect(
			filterDiscoverableRooms(rooms, SPACE_ID, member, mockMxcToHttp)[0]
				.canKnock,
		).toBe(true);
		expect(
			filterDiscoverableRooms(rooms, SPACE_ID, {}, mockMxcToHttp)[0].canKnock,
		).toBe(false);
	});

	it("excludes rooms with a pending knock from discoverable rooms", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!knocked:example.com",
				join_rule: "knock",
			}),
		];
		const summaries: SummariesStore = {
			"!knocked:example.com": makeSummary("!knocked:example.com", "knock"),
		};
		expect(
			filterDiscoverableRooms(rooms, SPACE_ID, summaries, mockMxcToHttp),
		).toEqual([]);
	});

	it("sets canJoin=true for restricted rooms when joined to parent space", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!restricted:example.com",
				join_rule: "restricted",
			}),
		];
		const summaries: SummariesStore = {
			[SPACE_ID]: makeSummary(SPACE_ID, "join", true),
		};
		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			mockMxcToHttp,
		);
		expect(result[0].canJoin).toBe(true);
	});

	it("sets canJoin=false for restricted rooms when not joined to parent space", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!restricted:example.com",
				join_rule: "restricted",
			}),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, mockMxcToHttp);
		expect(result[0].canJoin).toBe(false);
	});

	it("sets canJoin=false for restricted rooms when only invited to parent space", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!restricted:example.com",
				join_rule: "restricted",
			}),
		];
		const summaries: SummariesStore = {
			[SPACE_ID]: makeSummary(SPACE_ID, "invite", true),
		};
		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			mockMxcToHttp,
		);
		expect(result[0].canJoin).toBe(false);
	});

	it("sets canJoin=true for knock_restricted rooms when joined to parent space", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!knockrestricted:example.com",
				join_rule: "knock_restricted" as string,
			}),
		];
		const summaries: SummariesStore = {
			[SPACE_ID]: makeSummary(SPACE_ID, "join", true),
		};
		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			mockMxcToHttp,
		);
		expect(result[0].canJoin).toBe(true);
	});

	it("sets canJoin=false for knock_restricted rooms when not joined to parent space", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!knockrestricted:example.com",
				join_rule: "knock_restricted" as string,
			}),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, mockMxcToHttp);
		expect(result[0].canJoin).toBe(false);
	});

	it("sets canJoin=false for invite-only rooms", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!inv:example.com",
				join_rule: "invite",
			}),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, mockMxcToHttp);
		expect(result[0].canJoin).toBe(false);
	});

	it("sets canJoin=false when join_rule is undefined", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!nojoin:example.com",
				join_rule: undefined,
			}),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, mockMxcToHttp);
		expect(result[0].canJoin).toBe(false);
	});

	it("returns empty array when no discoverable rooms exist", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, mockMxcToHttp);
		expect(result).toEqual([]);
	});

	it("handles empty hierarchy", () => {
		const result = filterDiscoverableRooms([], SPACE_ID, {}, mockMxcToHttp);
		expect(result).toEqual([]);
	});

	it("sets avatarUrl to null when avatar_url is missing", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!noavatar:example.com",
				avatar_url: undefined,
				join_rule: "public",
			}),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, mockMxcToHttp);
		expect(result[0].avatarUrl).toBeNull();
	});
});
