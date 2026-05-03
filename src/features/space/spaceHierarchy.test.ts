import type { HierarchyRoom } from "matrix-js-sdk";
import { JoinRule } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import type { RoomSummary, SummariesStore } from "../../client/summaries";
import { extractViaServers, filterDiscoverableRooms } from "./spaceHierarchy";

function makeHierarchyRoom(
	overrides: Partial<HierarchyRoom> & { room_id: string },
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
		join_rule: overrides.join_rule,
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
		membership,
		isEncrypted: false,
		isDirect: false,
		isSpace,
		children: [],
	};
}

const BASE_URL = "https://example.com";
const SPACE_ID = "!space:example.com";

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
				join_rule: JoinRule.Public,
			}),
		];
		const summaries: SummariesStore = {};

		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			BASE_URL,
		);
		expect(result).toHaveLength(1);
		expect(result[0].roomId).toBe("!room1:example.com");
	});

	it("excludes sub-spaces (room_type m.space)", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!subspace:example.com",
				room_type: "m.space",
			}),
			makeHierarchyRoom({
				room_id: "!room1:example.com",
				join_rule: JoinRule.Public,
			}),
		];
		const summaries: SummariesStore = {};

		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			BASE_URL,
		);
		expect(result).toHaveLength(1);
		expect(result[0].roomId).toBe("!room1:example.com");
	});

	it("excludes rooms the user has already joined", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!joined:example.com",
				join_rule: JoinRule.Public,
			}),
			makeHierarchyRoom({
				room_id: "!notjoined:example.com",
				join_rule: JoinRule.Public,
			}),
		];
		const summaries: SummariesStore = {
			"!joined:example.com": makeSummary("!joined:example.com", "join"),
		};

		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			BASE_URL,
		);
		expect(result).toHaveLength(1);
		expect(result[0].roomId).toBe("!notjoined:example.com");
	});

	it("includes rooms with non-join membership (invite, leave, ban)", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!invited:example.com",
				join_rule: JoinRule.Public,
			}),
			makeHierarchyRoom({
				room_id: "!left:example.com",
				join_rule: JoinRule.Public,
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
			BASE_URL,
		);
		expect(result).toHaveLength(2);
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
				join_rule: JoinRule.Public,
			}),
		];
		const summaries: SummariesStore = {};

		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			BASE_URL,
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
		});
	});

	it("falls back to canonical_alias then room_id for name", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!room1:example.com",
				name: undefined,
				canonical_alias: "#general:example.com",
				join_rule: JoinRule.Public,
			}),
			makeHierarchyRoom({
				room_id: "!room2:example.com",
				name: undefined,
				canonical_alias: undefined,
				join_rule: JoinRule.Public,
			}),
		];
		const summaries: SummariesStore = {};

		const result = filterDiscoverableRooms(
			rooms,
			SPACE_ID,
			summaries,
			BASE_URL,
		);
		expect(result[0].name).toBe("#general:example.com");
		expect(result[1].name).toBe("!room2:example.com");
	});

	it("sets canJoin=true for public rooms", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!pub:example.com",
				join_rule: JoinRule.Public,
			}),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, BASE_URL);
		expect(result[0].canJoin).toBe(true);
	});

	it("sets canJoin=false for knock rooms", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!knock:example.com",
				join_rule: JoinRule.Knock,
			}),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, BASE_URL);
		expect(result[0].canJoin).toBe(false);
	});

	it("sets canJoin=true for restricted rooms", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!restricted:example.com",
				join_rule: JoinRule.Restricted as JoinRule.Public,
			}),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, BASE_URL);
		expect(result[0].canJoin).toBe(true);
	});

	it("sets canJoin=false for invite-only rooms", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!inv:example.com",
				join_rule: JoinRule.Invite as JoinRule.Public,
			}),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, BASE_URL);
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
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, BASE_URL);
		expect(result[0].canJoin).toBe(false);
	});

	it("returns empty array when no discoverable rooms exist", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, BASE_URL);
		expect(result).toEqual([]);
	});

	it("handles empty hierarchy", () => {
		const result = filterDiscoverableRooms([], SPACE_ID, {}, BASE_URL);
		expect(result).toEqual([]);
	});

	it("sets avatarUrl to null when avatar_url is missing", () => {
		const rooms: HierarchyRoom[] = [
			makeHierarchyRoom({ room_id: SPACE_ID, room_type: "m.space" }),
			makeHierarchyRoom({
				room_id: "!noavatar:example.com",
				avatar_url: undefined,
				join_rule: JoinRule.Public,
			}),
		];
		const result = filterDiscoverableRooms(rooms, SPACE_ID, {}, BASE_URL);
		expect(result[0].avatarUrl).toBeNull();
	});
});
