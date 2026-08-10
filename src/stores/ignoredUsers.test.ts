import type { MatrixEvent } from "matrix-js-sdk";
import { ClientEvent } from "matrix-js-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createMockClient } from "../test/mockClient";
import {
	_resetIgnoredUsersForTests,
	ignoredUsers,
	initIgnoredUsers,
	isUserIgnored,
	setUserIgnored,
} from "./ignoredUsers";

function makeAccountDataEvent(type: string): MatrixEvent {
	return { getType: () => type } as unknown as MatrixEvent;
}

afterEach(() => {
	_resetIgnoredUsersForTests();
});

describe("initIgnoredUsers", () => {
	it("populates the store from the client's ignore list", () => {
		const client = createMockClient();
		client.getIgnoredUsers.mockReturnValue(["@spam:example.com"]);
		initIgnoredUsers(client as never);
		expect(ignoredUsers()).toEqual(["@spam:example.com"]);
		expect(isUserIgnored("@spam:example.com")).toBe(true);
	});

	it("defaults to an empty list when the client has none", () => {
		const client = createMockClient();
		client.getIgnoredUsers.mockReturnValue(undefined as never);
		initIgnoredUsers(client as never);
		expect(ignoredUsers()).toEqual([]);
	});

	it("refreshes when the m.ignored_user_list account data changes", () => {
		const client = createMockClient();
		client.getIgnoredUsers.mockReturnValue([]);
		initIgnoredUsers(client as never);
		expect(ignoredUsers()).toEqual([]);

		client.getIgnoredUsers.mockReturnValue(["@later:example.com"]);
		client.__emit(
			ClientEvent.AccountData,
			makeAccountDataEvent("m.ignored_user_list"),
		);
		expect(ignoredUsers()).toEqual(["@later:example.com"]);
	});

	it("ignores unrelated account data events", () => {
		const client = createMockClient();
		client.getIgnoredUsers.mockReturnValue([]);
		initIgnoredUsers(client as never);
		client.getIgnoredUsers.mockReturnValue(["@later:example.com"]);
		client.__emit(ClientEvent.AccountData, makeAccountDataEvent("m.direct"));
		expect(ignoredUsers()).toEqual([]);
	});

	it("drops the listener and clears the store on cleanup", () => {
		const client = createMockClient();
		client.getIgnoredUsers.mockReturnValue(["@spam:example.com"]);
		initIgnoredUsers(client as never);
		_resetIgnoredUsersForTests();
		expect(ignoredUsers()).toEqual([]);
		client.getIgnoredUsers.mockReturnValue(["@other:example.com"]);
		client.__emit(
			ClientEvent.AccountData,
			makeAccountDataEvent("m.ignored_user_list"),
		);
		expect(ignoredUsers()).toEqual([]);
	});
});

describe("setUserIgnored", () => {
	it("adds a user and persists the full list", async () => {
		const client = createMockClient();
		client.getIgnoredUsers.mockReturnValue(["@existing:example.com"]);
		await setUserIgnored(client as never, "@new:example.com", true);
		expect(client.setIgnoredUsers).toHaveBeenCalledWith([
			"@existing:example.com",
			"@new:example.com",
		]);
		expect(ignoredUsers()).toEqual([
			"@existing:example.com",
			"@new:example.com",
		]);
	});

	it("removes a user", async () => {
		const client = createMockClient();
		client.getIgnoredUsers.mockReturnValue([
			"@a:example.com",
			"@b:example.com",
		]);
		await setUserIgnored(client as never, "@a:example.com", false);
		expect(client.setIgnoredUsers).toHaveBeenCalledWith(["@b:example.com"]);
		expect(ignoredUsers()).toEqual(["@b:example.com"]);
	});

	it("is a no-op when the requested state already holds", async () => {
		const client = createMockClient();
		client.getIgnoredUsers.mockReturnValue(["@a:example.com"]);
		await setUserIgnored(client as never, "@a:example.com", true);
		await setUserIgnored(client as never, "@missing:example.com", false);
		expect(client.setIgnoredUsers).not.toHaveBeenCalled();
	});

	it("does not update the store when the write fails", async () => {
		const client = createMockClient();
		client.getIgnoredUsers.mockReturnValue([]);
		client.setIgnoredUsers.mockRejectedValue(new Error("network"));
		await expect(
			setUserIgnored(client as never, "@a:example.com", true),
		).rejects.toThrow("network");
		expect(ignoredUsers()).toEqual([]);
	});
});
