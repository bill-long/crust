import { afterEach, describe, expect, it } from "vitest";
import { _resetLastRoomForTests, getLastRoom, setLastRoom } from "./lastRoom";

const STORAGE_KEY = "crust:last-room";

afterEach(() => {
	_resetLastRoomForTests();
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

	it("persists to localStorage", () => {
		setLastRoom("!r:example.com", "!s:example.com");
		const raw = localStorage.getItem(STORAGE_KEY);
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
