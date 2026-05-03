import type { MatrixClient, RoomMember } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { createMockClient, createMockRoom } from "../../test/mockClient";
import {
	buildEntry,
	groupMembers,
	type MemberEntry,
	roleForPowerLevel,
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
