import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetLastChannelsForTests,
	getLastChannel,
	setLastChannel,
} from "./lastChannel";
import { clearSession, type Session, saveSession } from "./session";

const STORAGE_KEY = "crust:last-channel";

const ACCOUNT_A: Session = {
	accessToken: "syt_a",
	userId: "@alice:example.com",
	deviceId: "DEV_A",
	homeserverUrl: "https://matrix.example.com",
};
const ACCOUNT_B: Session = {
	...ACCOUNT_A,
	accessToken: "syt_b",
	userId: "@bob:example.com",
	deviceId: "DEV_B",
};

/** The key the store files values under while `userId` is the active account. */
const keyFor = (userId: string): string => `${STORAGE_KEY}:${userId}`;

beforeEach(() => {
	localStorage.clear();
	saveSession(ACCOUNT_A);
});

afterEach(() => {
	_resetLastChannelsForTests();
	clearSession(ACCOUNT_A.userId);
	localStorage.clear();
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

	it("persists to localStorage under the active account's key", () => {
		setLastChannel("!s:example.com", "!r:example.com");
		const raw = localStorage.getItem(keyFor(ACCOUNT_A.userId));
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw as string)).toEqual({
			"!s:example.com": "!r:example.com",
		});
	});

	it("does not return inherited Object.prototype members for unset keys", () => {
		expect(getLastChannel("toString")).toBeUndefined();
		expect(getLastChannel("__proto__")).toBeUndefined();
		expect(getLastChannel("constructor")).toBeUndefined();
	});

	it("treats prototype-polluting keys as plain own entries without polluting", () => {
		setLastChannel("__proto__", "!evil:example.com");
		setLastChannel("toString", "!ts:example.com");
		expect(getLastChannel("__proto__")).toBe("!evil:example.com");
		expect(getLastChannel("toString")).toBe("!ts:example.com");
		// Global prototype must be untouched.
		expect(({} as Record<string, unknown>).evil).toBeUndefined();
		expect(typeof {}.toString).toBe("function");
	});
});

describe("account scoping", () => {
	it("keeps each account's per-space rooms separate across a switch", () => {
		setLastChannel("!s:example.com", "!a:example.com");
		saveSession(ACCOUNT_B);
		// Both accounts can be in the same space; the room each was reading
		// there is still their own.
		expect(getLastChannel("!s:example.com")).toBeUndefined();
		setLastChannel("!s:example.com", "!b:example.com");
		saveSession(ACCOUNT_A);
		expect(getLastChannel("!s:example.com")).toBe("!a:example.com");
	});
});
