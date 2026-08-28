import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetLastRoomForTests, getLastRoom, setLastRoom } from "./lastRoom";
import {
	clearSession,
	freezeAccountScope,
	type Session,
	saveSession,
	unfreezeAccountScope,
} from "./session";

const STORAGE_KEY = "crust:last-room";

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
	_resetLastRoomForTests();
	clearSession(ACCOUNT_A.userId);
	localStorage.clear();
});

describe("lastRoom store", () => {
	it("returns null when nothing is recorded", () => {
		expect(getLastRoom()).toBeNull();
	});

	it("records a home/DM room with no space", () => {
		setLastRoom("!room:example.com");
		expect(getLastRoom()).toEqual({ roomId: "!room:example.com" });
	});

	it("records a room together with the space it was viewed under", () => {
		setLastRoom("!room:example.com", "!space:example.com");
		expect(getLastRoom()).toEqual({
			roomId: "!room:example.com",
			spaceId: "!space:example.com",
		});
	});

	it("overwrites the prior room with the most recent one", () => {
		setLastRoom("!a:example.com", "!s:example.com");
		setLastRoom("!b:example.com");
		expect(getLastRoom()).toEqual({ roomId: "!b:example.com" });
	});

	it("persists to localStorage under the active account's key", () => {
		setLastRoom("!r:example.com", "!s:example.com");
		const raw = localStorage.getItem(keyFor(ACCOUNT_A.userId));
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw as string)).toEqual({
			roomId: "!r:example.com",
			spaceId: "!s:example.com",
		});
	});

	it("keeps the same reference when re-recording an identical room", () => {
		setLastRoom("!r:example.com", "!s:example.com");
		const first = getLastRoom();
		setLastRoom("!r:example.com", "!s:example.com");
		// Functional update returns prev unchanged for a duplicate, so the
		// signal value is referentially stable (no needless re-render/write).
		expect(getLastRoom()).toBe(first);
	});

	it("updates when the same room is re-viewed under a different space", () => {
		setLastRoom("!r:example.com", "!s1:example.com");
		setLastRoom("!r:example.com", "!s2:example.com");
		expect(getLastRoom()).toEqual({
			roomId: "!r:example.com",
			spaceId: "!s2:example.com",
		});
	});

	it("clears state and persistence on reset", () => {
		setLastRoom("!r:example.com");
		_resetLastRoomForTests();
		expect(getLastRoom()).toBeNull();
		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
	});
});

describe("account scoping", () => {
	it("keeps each account's last room separate across a switch", () => {
		setLastRoom("!a:example.com");
		saveSession(ACCOUNT_B);
		// B has never opened a room: it must not inherit A's.
		expect(getLastRoom()).toBeNull();
		setLastRoom("!b:example.com");
		expect(localStorage.getItem(keyFor(ACCOUNT_A.userId))).toBe(
			JSON.stringify({ roomId: "!a:example.com" }),
		);
		saveSession(ACCOUNT_A);
		expect(getLastRoom()).toEqual({ roomId: "!a:example.com" });
	});

	it("writes nowhere once a switch has committed", () => {
		// The pointer has moved but this document still belongs to the outgoing
		// account, so a write here would be filed under the incoming account.
		setLastRoom("!before:example.com");
		freezeAccountScope();
		try {
			setLastRoom("!during:example.com");
			expect(localStorage.getItem(keyFor(ACCOUNT_A.userId))).toBe(
				JSON.stringify({ roomId: "!before:example.com" }),
			);
		} finally {
			unfreezeAccountScope();
		}
	});

	it("keeps writes in memory while no account is active", () => {
		clearSession(ACCOUNT_A.userId);
		setLastRoom("!r:example.com");
		expect(getLastRoom()).toEqual({ roomId: "!r:example.com" });
		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
	});
});
