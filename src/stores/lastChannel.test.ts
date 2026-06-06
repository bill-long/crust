import { afterEach, describe, expect, it } from "vitest";
import {
	_resetLastChannelsForTests,
	getLastChannel,
	setLastChannel,
} from "./lastChannel";

const STORAGE_KEY = "crust:last-channel";

afterEach(() => {
	_resetLastChannelsForTests();
});

describe("lastChannel store", () => {
	it("returns undefined for an unknown space", () => {
		expect(getLastChannel("!nope:example.com")).toBeUndefined();
	});

	it("records and reads back the last channel per space", () => {
		setLastChannel("!space:example.com", "!room:example.com");
		expect(getLastChannel("!space:example.com")).toBe("!room:example.com");
	});

	it("keeps separate channels for separate spaces", () => {
		setLastChannel("!a:example.com", "!ra:example.com");
		setLastChannel("!b:example.com", "!rb:example.com");
		expect(getLastChannel("!a:example.com")).toBe("!ra:example.com");
		expect(getLastChannel("!b:example.com")).toBe("!rb:example.com");
	});

	it("overwrites a prior channel for the same space", () => {
		setLastChannel("!s:example.com", "!r1:example.com");
		setLastChannel("!s:example.com", "!r2:example.com");
		expect(getLastChannel("!s:example.com")).toBe("!r2:example.com");
	});

	it("persists to localStorage", () => {
		setLastChannel("!s:example.com", "!r:example.com");
		const raw = localStorage.getItem(STORAGE_KEY);
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw as string)).toEqual({
			"!s:example.com": "!r:example.com",
		});
	});
});
