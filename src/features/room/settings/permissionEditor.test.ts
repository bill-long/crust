import { describe, expect, it } from "vitest";
import {
	inheritedPermission,
	parsePermissionLevel,
	permissionEditError,
	withPermission,
} from "./permissionEditor";

describe("permission editor authorization", () => {
	it("protects creators, peers and own elevation while allowing self demotion", () => {
		const levels = { users: { "@peer:s": 100, "@me:s": 100, "@other:s": 50 } };
		const edit = (id: string, level: number | null, creator = false) =>
			permissionEditError(
				levels,
				{ section: "users", key: id },
				level,
				"@me:s",
				100,
				creator,
			);
		expect(edit("@peer:s", 0)).toContain("equal or higher");
		expect(edit("@other:s", 100)).toBeNull();
		expect(edit("@me:s", 101)).toContain("above your own");
		expect(edit("@me:s", 50)).toBeNull();
		expect(edit("@other:s", 0, true)).toContain("permanent");
		expect(edit("not-a-user", 0)).toContain("Matrix user ID");
		for (const id of [
			"@alice:server/path",
			"@a b:server",
			" @alice:server",
			"@alice:server?query",
		])
			expect(edit(id, 0)).toContain("Matrix user ID");
		for (const id of [
			"@alice:server",
			"@alice:server:8448",
			"@alice:[::1]:8448",
		])
			expect(edit(id, 0)).toBeNull();
	});
	it("accepts only exact safe integers, including negative levels", () => {
		for (const input of ["", "2.5", "Infinity", "1e2", "9007199254740992"])
			expect(parsePermissionLevel(input)).toBeNull();
		expect(parsePermissionLevel(" -3 ")).toBe(-3);
	});
	it("removes overrides without mutating input or dropping extension fields", () => {
		const input = {
			events: { "m.room.topic": 20, other: 15 },
			users: { "@a:s": 0 },
			notifications: { room: 70 },
			extension: { kept: true },
		};
		expect(
			withPermission(input, { section: "events", key: "m.room.topic" }, null),
		).toEqual({ ...input, events: { other: 15 } });
		expect(input.events["m.room.topic"]).toBe(20);
		expect(
			inheritedPermission(input, { section: "notifications", key: "room" }),
		).toBe(50);
		expect(
			inheritedPermission(input, { section: "events", key: "unknown" }),
		).toBeUndefined();
	});
	it("treats prototype-like event identifiers as data", () => {
		const next = withPermission(
			{},
			{ section: "events", key: "__proto__" },
			12,
		);
		expect(Object.hasOwn(next.events ?? {}, "__proto__")).toBe(true);
		expect(JSON.stringify(next)).toBe('{"events":{"__proto__":12}}');
	});
});
it("authorizes explicit additions and removals independently of inherited levels", () => {
	const content = {
		state_default: 100,
		users_default: 100,
		events: { "m.room.power_levels": 50 },
		users: { "@other:s": 0 },
	};
	expect(
		permissionEditError(
			content,
			{ section: "users", key: "@other:s" },
			null,
			"@me:s",
			50,
			false,
		),
	).toBeNull();
	expect(
		permissionEditError(
			content,
			{ section: "users", key: "@new:s" },
			0,
			"@me:s",
			50,
			false,
		),
	).toBeNull();
	expect(
		permissionEditError(
			content,
			{ section: "events", key: "m.room.topic" },
			50,
			"@me:s",
			50,
			false,
		),
	).toBeNull();
	expect(
		permissionEditError(
			{},
			{ section: "defaults", key: "kick" },
			0,
			"@me:s",
			0,
			false,
		),
	).toBeNull();
	expect(
		permissionEditError(
			{ kick: 75 },
			{ section: "defaults", key: "kick" },
			0,
			"@me:s",
			50,
			false,
		),
	).toContain("above your level");
});
