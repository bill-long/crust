import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import {
	carryNoticeIntoSession,
	clearNotices,
	notices,
	pushNotice,
} from "../stores/notices";
import { NoticeToasts } from "./NoticeToasts";

/** One macrotask, which is what the carried-notice delivery waits for. */
const nextTask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

const liveRegion = (): HTMLElement | null =>
	document.querySelector('[aria-live="polite"]');

beforeEach(() => clearNotices());
afterEach(() => {
	cleanup();
	clearNotices();
});

describe("NoticeToasts", () => {
	it("drops the previous session's notices as it mounts", async () => {
		// Pushed while this renderer was unmounted, so nothing armed a timer for
		// it and it would otherwise resurface, stale, on the next login.
		pushNotice("left over from the last session");

		render(() => <NoticeToasts />);

		expect(screen.queryByText("left over from the last session")).toBeNull();
		await nextTask();
		expect(screen.queryByText("left over from the last session")).toBeNull();
	});

	it("announces a carried notice by adding it to a live region that exists", async () => {
		// The region only announces mutations that happen after it is registered;
		// content already present when it first appears is painted and never read
		// out. So the region must be in the DOM for a beat with nothing in it.
		carryNoticeIntoSession("you're already signed in");

		render(() => <NoticeToasts />);

		expect(liveRegion()).not.toBeNull();
		expect(screen.queryByText("you're already signed in")).toBeNull();

		await nextTask();

		const shown = screen.getByText("you're already signed in");
		expect(liveRegion()?.contains(shown)).toBe(true);
	});

	it("delivers a carried notice once", async () => {
		carryNoticeIntoSession("you're already signed in");
		render(() => <NoticeToasts />);
		await nextTask();
		expect(notices()).toHaveLength(1);

		cleanup();
		render(() => <NoticeToasts />);
		await nextTask();

		expect(notices()).toEqual([]);
	});

	it("does not deliver after it has been unmounted", async () => {
		// The delivery is a pending timer at that point; left running it would
		// push into a session that has already gone away.
		carryNoticeIntoSession("you're already signed in");
		render(() => <NoticeToasts />);

		cleanup();
		await nextTask();

		expect(notices()).toEqual([]);
	});

	it("renders an ordinary notice pushed while it is up", async () => {
		render(() => <NoticeToasts />);
		await nextTask();

		pushNotice("something happened");

		const shown = screen.getByText("something happened");
		expect(liveRegion()?.contains(shown)).toBe(true);
	});
});
