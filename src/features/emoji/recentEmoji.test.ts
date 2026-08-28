import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSession, type Session, saveSession } from "../../stores/session";
import { addRecentEmoji, getRecentEmoji } from "./recentEmoji";

const STORAGE_KEY = "crust:recent-emoji";

const ALICE: Session = {
	accessToken: "syt_a",
	userId: "@alice:example.com",
	deviceId: "DEV_A",
	homeserverUrl: "https://matrix.example.com",
};
const BOB: Session = {
	...ALICE,
	accessToken: "syt_b",
	userId: "@bob:example.com",
	deviceId: "DEV_B",
};

beforeEach(() => {
	localStorage.clear();
	saveSession(ALICE);
});
afterEach(() => {
	clearSession(ALICE.userId);
	localStorage.clear();
});

describe("recentEmoji", () => {
	it("records uses most-recent-first", () => {
		addRecentEmoji("😀");
		addRecentEmoji("🎉");
		expect(getRecentEmoji()).toEqual(["🎉", "😀"]);
	});

	it("moves a re-used emoji to the front without duplicating it", () => {
		addRecentEmoji("😀");
		addRecentEmoji("🎉");
		addRecentEmoji("😀");
		expect(getRecentEmoji()).toEqual(["😀", "🎉"]);
	});

	it("caps the list at 32 entries", () => {
		for (let i = 0; i < 40; i++) addRecentEmoji(`e${i}`);
		expect(getRecentEmoji()).toHaveLength(32);
		expect(getRecentEmoji()[0]).toBe("e39");
	});

	it("persists under the active account's key", () => {
		addRecentEmoji("😀");
		expect(
			localStorage.getItem(`${STORAGE_KEY}:${ALICE.userId}`),
		).not.toBeNull();
		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
	});

	it("keeps each account's list separate", () => {
		addRecentEmoji("😀");
		saveSession(BOB);
		expect(getRecentEmoji()).toEqual([]);
		addRecentEmoji("🎉");
		expect(getRecentEmoji()).toEqual(["🎉"]);
		saveSession(ALICE);
		expect(getRecentEmoji()).toEqual(["😀"]);
	});

	it("reads empty and writes nothing while logged out", () => {
		clearSession(ALICE.userId);
		addRecentEmoji("😀");
		expect(getRecentEmoji()).toEqual([]);
		expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
	});
});
