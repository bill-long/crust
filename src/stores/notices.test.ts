import { afterEach, describe, expect, it } from "vitest";
import { requiredAt } from "../test/assertions";
import {
	carryNoticeIntoSession,
	clearNotices,
	dismissNotice,
	notices,
	pushNotice,
	takeCarriedNotice,
} from "./notices";

// `clearNotices` drains the carry slot too, so nothing leaks into the next test.
afterEach(() => clearNotices());

describe("notices store", () => {
	it("starts empty", () => {
		expect(notices()).toEqual([]);
	});

	it("appends a pushed notice with the given message and tone", () => {
		pushNotice("hello", "error");
		expect(notices()).toHaveLength(1);
		expect(requiredAt(notices(), 0, "pushed notice")).toMatchObject({
			message: "hello",
			tone: "error",
		});
	});

	it("defaults the tone to info", () => {
		pushNotice("plain");
		expect(requiredAt(notices(), 0, "plain notice").tone).toBe("info");
	});

	it("returns a unique id per notice and preserves order", () => {
		const a = pushNotice("a");
		const b = pushNotice("b");
		expect(a).not.toBe(b);
		expect(notices().map((n) => n.message)).toEqual(["a", "b"]);
	});

	it("dismisses only the notice with the matching id", () => {
		const a = pushNotice("a");
		pushNotice("b");
		dismissNotice(a);
		expect(notices().map((n) => n.message)).toEqual(["b"]);
	});

	it("is a no-op when dismissing an unknown id", () => {
		pushNotice("a");
		dismissNotice(9999);
		expect(notices()).toHaveLength(1);
	});

	it("clears all notices", () => {
		pushNotice("a");
		pushNotice("b");
		clearNotices();
		expect(notices()).toEqual([]);
	});
});

describe("session handover", () => {
	/**
	 * What `NoticeToasts` does as it mounts: take the slot, drop the previous
	 * session's notices, push what it took. (It pushes a task later, for the
	 * live region's sake - that timing is the renderer's, not the store's.)
	 */
	const startSession = (): void => {
		const carried = takeCarriedNotice();
		clearNotices();
		if (carried !== null) pushNotice(carried.message, carried.tone);
	};

	it("drops what the previous session left behind", () => {
		pushNotice("stale");
		startSession();
		expect(notices()).toEqual([]);
	});

	it("hands the carried notice over exactly once", () => {
		// The renderer clears right after taking, which would hide a `take` that
		// only peeked - so the one-shot is pinned here, where it is the contract.
		carryNoticeIntoSession("on the way in");
		expect(takeCarriedNotice()).toMatchObject({ message: "on the way in" });
		expect(takeCarriedNotice()).toBeNull();
	});

	it("shows nothing until the session starts", () => {
		carryNoticeIntoSession("on the way in");
		// The app root has not mounted, so there is nothing to render it and no
		// timer to expire it. It must not be in the visible list yet.
		expect(notices()).toEqual([]);
	});

	it("delivers a carried notice when the session starts", () => {
		carryNoticeIntoSession("on the way in", "error");
		startSession();
		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toMatchObject({
			message: "on the way in",
			tone: "error",
		});
	});

	it("defaults a carried notice to the info tone", () => {
		carryNoticeIntoSession("plain");
		startSession();
		expect(requiredAt(notices(), 0, "carried notice").tone).toBe("info");
	});

	it("delivers a carried notice instead of the previous session's", () => {
		pushNotice("stale");
		carryNoticeIntoSession("on the way in");
		startSession();
		expect(notices().map((n) => n.message)).toEqual(["on the way in"]);
	});

	it("delivers a carried notice once and then forgets it", () => {
		// Otherwise it would reappear at the start of every later session - the
		// exact staleness the drop above exists to prevent.
		carryNoticeIntoSession("on the way in");
		startSession();
		clearNotices();
		startSession();
		expect(notices()).toEqual([]);
	});

	it("gives a carried notice a dismissable id", () => {
		pushNotice("first");
		carryNoticeIntoSession("carried");
		startSession();
		const id = requiredAt(notices(), 0, "carried notice").id;
		dismissNotice(id);
		expect(notices()).toEqual([]);
	});

	it("is drained by clearNotices, which means ALL notices", () => {
		// A caller clearing up cannot be expected to know a second, invisible slot
		// exists - and one left there surfaces on top of an unrelated later
		// session.
		carryNoticeIntoSession("never delivered");
		clearNotices();
		startSession();
		expect(notices()).toEqual([]);
	});
});
