/**
 * Browser-mode regression tests for TimelineView's layout-dependent
 * control paths (PR #79, issue #82). jsdom can't drive real layout,
 * ResizeObserver, or RAF cadence, so these run in headless Chromium
 * via Vitest browser mode.
 */

import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, onCleanup, onMount } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../styles/global.css";
import {
	installTimelineHarness,
	makeTimelineHarnessRef,
	TestClientProvider,
} from "../../../test/TimelineHarness";
import type { TimelineEvent } from "./useTimeline";

// vi.mock is hoisted above imports, but its factory runs lazily on
// first import of the mocked module. Top-level harness is already
// initialised by then. (See the docs at the head of TimelineHarness
// for the wiring.)
const harness = makeTimelineHarnessRef();

vi.mock("./useTimeline", () => ({
	useTimeline: installTimelineHarness(harness),
}));

// Composer pulls in much of the SDK surface and adds layout below the
// scroller. Tests focus on scroll behaviour, so stub it out.
vi.mock("../composer/Composer", () => ({
	Composer: () => null,
}));

const { TimelineView } = await import("./TimelineView");

let nextSyntheticId = 0;
function mkEvent(eventId: string, body: string, ts: number): TimelineEvent {
	return {
		eventId,
		senderId: "@alice:example.com",
		senderName: "Alice",
		timestamp: ts,
		type: "m.room.message",
		msgtype: "m.text",
		body,
		format: null,
		formattedBody: null,
		imageUrl: null,
		imageWidth: null,
		imageHeight: null,
		imageFullUrl: null,
		imageMimetype: null,
		imageSize: null,
		imageFilename: null,
		imageIsEncrypted: false,
		isEncrypted: false,
		isDecryptionFailure: false,
		isEdited: false,
		reactions: {},
		myReactions: {},
		status: null,
	};
}

function manyEvents(n: number, prefix = "$evt"): TimelineEvent[] {
	const arr: TimelineEvent[] = [];
	for (let i = 0; i < n; i++) {
		arr.push(
			mkEvent(
				`${prefix}_${i}_${nextSyntheticId++}`,
				`${prefix} message ${i}`,
				1700000000000 + i * 1000,
			),
		);
	}
	return arr;
}

function getScroller(container: HTMLElement): HTMLElement {
	const el = container.querySelector<HTMLElement>(
		'[data-testid="timeline-scroller"]',
	);
	if (!el) throw new Error("scroller not found");
	return el;
}

function distFromBottom(el: HTMLElement): number {
	return el.scrollHeight - el.scrollTop - el.clientHeight;
}

const ROOM_EVENT = "__test_set_room";

/**
 * Renders TimelineView with a roomId driven by an internal signal so
 * tests can swap rooms via `setRoomId()`.
 */
function RoomSwitcher(props: { initialRoomId: string }) {
	const [roomId, setRoomId] = createSignal(props.initialRoomId);
	let host: HTMLDivElement | undefined;
	onMount(() => {
		const handler = (e: Event): void => {
			const detail = (e as CustomEvent<string>).detail;
			if (typeof detail === "string") setRoomId(detail);
		};
		const target = host?.parentElement ?? document.body;
		target.addEventListener(ROOM_EVENT, handler);
		onCleanup(() => target.removeEventListener(ROOM_EVENT, handler));
	});
	return (
		<div ref={host} style={{ width: "100%", height: "100%" }}>
			<TimelineView roomId={roomId()} />
		</div>
	);
}

function mount(initialRoomId: string) {
	const wrapper = document.createElement("div");
	wrapper.setAttribute("data-timeline-test", "");
	wrapper.style.cssText =
		"position:fixed;inset:0;width:800px;height:400px;background:#000;";
	document.body.appendChild(wrapper);
	const result = render(
		() => (
			<TestClientProvider>
				<RoomSwitcher initialRoomId={initialRoomId} />
			</TestClientProvider>
		),
		{ container: wrapper },
	);
	return {
		container: wrapper,
		getScroller: () => getScroller(wrapper),
		setRoomId(next: string) {
			wrapper.dispatchEvent(
				new CustomEvent(ROOM_EVENT, { detail: next, bubbles: false }),
			);
		},
		unmount() {
			result.unmount();
			wrapper.remove();
		},
	};
}

const frame = (): Promise<void> =>
	new Promise((r) => requestAnimationFrame(() => r()));
// Fixed sleep, used ONLY for "verify a snap did NOT happen" assertions.
// You can't poll for a non-event, so we give the bottom-pin RAF a bounded
// window to (not) fire, then assert position is unchanged. Do not use for
// "wait until X is true" — use expect.poll for those.
const wait = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
	harness.reset();
	nextSyntheticId = 0;
});

afterEach(() => {
	cleanup();
	for (const el of Array.from(
		document.querySelectorAll('[data-timeline-test=""]'),
	)) {
		el.remove();
	}
});

describe("TimelineView (browser)", () => {
	// Test 1: room-entry pin survives the slow loading fallback. The
	// scroller is unmounted while <Show> renders the loading
	// fallback; settleAtBottom() must retry-until-mounted so the
	// initial bottom pin still applies once the scroller appears.
	it("room-entry pin survives a slow loading fallback", async () => {
		const roomId = "!room1:example.com";
		harness.setRoomState(roomId, { loading: true });
		const m = mount(roomId);
		await frame();
		await frame();
		harness.setRoomState(roomId, {
			loading: false,
			events: manyEvents(40, "$initial"),
		});
		await expect
			.poll(() => distFromBottom(m.getScroller()), {
				timeout: 2000,
				interval: 50,
			})
			.toBeLessThan(2);
		m.unmount();
	});

	// Test 2: A→B→A. With per-room snapshots the test catches a
	// stale-element regression (TimelineView reading a ref that points
	// at the previous room's scroller). Room B uses distinct content
	// so a stale-data bug would also be visible.
	it("A->B->A room switch renders B's content then re-pins A", async () => {
		const roomA = "!a:example.com";
		const roomB = "!b:example.com";
		harness.setRoomState(roomA, { events: manyEvents(40, "$alpha") });
		harness.setRoomState(roomB, { events: manyEvents(40, "$beta") });
		const m = mount(roomA);
		await expect
			.poll(() => distFromBottom(m.getScroller()), {
				timeout: 2000,
				interval: 50,
			})
			.toBeLessThan(2);
		expect(m.container.textContent).toMatch(/alpha/);
		m.setRoomId(roomB);
		await expect
			.poll(() => m.container.textContent ?? "", {
				timeout: 2000,
				interval: 50,
			})
			.toMatch(/beta/);
		await expect
			.poll(() => distFromBottom(m.getScroller()), {
				timeout: 2000,
				interval: 50,
			})
			.toBeLessThan(2);
		m.setRoomId(roomA);
		await expect
			.poll(() => m.container.textContent ?? "", {
				timeout: 2000,
				interval: 50,
			})
			.toMatch(/alpha/);
		await expect
			.poll(() => distFromBottom(m.getScroller()), {
				timeout: 2000,
				interval: 50,
			})
			.toBeLessThan(2);
		m.unmount();
	});

	// Test 3: auto-pagination routes through paginateOlder (which
	// toggles Virtua's `shift` prop). Auto-pagination is the
	// "viewport unfilled" path, so this verifies the wiring is
	// reachable. Asserting that `shift` literally preserved the
	// anchor under auto-pagination is unreliable because the
	// bottom-pin (wantsBottom=true on room entry) re-anchors anyway —
	// the rigorous shift verification lives in the manual-button test
	// below.
	it("auto-pagination invokes loadOlderMessages until viewport fills", async () => {
		const roomId = "!autopag:example.com";
		harness.setRoomState(roomId, {
			events: manyEvents(2, "$seed"),
			canLoadOlder: true,
		});
		harness.setLoadOlderHandler(roomId, async () => {
			harness.prependEvents(roomId, manyEvents(2, "$pad"));
		});
		const m = mount(roomId);
		await expect
			.poll(() => harness.loadOlderCallCount(roomId), {
				timeout: 3000,
				interval: 50,
			})
			.toBeGreaterThan(0);
		await expect
			.poll(() => distFromBottom(m.getScroller()), {
				timeout: 2000,
				interval: 50,
			})
			.toBeLessThan(2);
		m.unmount();
	});

	// Test 4 (rigorous shift verification): when the user is mid-
	// scroll (not following bottom) and triggers backward pagination,
	// the visible anchor row must not jump. paginateOlder() toggles
	// Virtua's `shift` prop; with it, scrollTop grows by the
	// prepended block's height and the anchor stays at the same
	// viewport offset. Without it, the anchor would slide downward by
	// the prepended block's height.
	it("backward pagination preserves the visible anchor (shift wiring)", async () => {
		const roomId = "!shift:example.com";
		harness.setRoomState(roomId, {
			events: manyEvents(200, "$body"),
			canLoadOlder: true,
		});
		// Prepend a block large enough that any missing-shift jump
		// would be obvious (well outside floating-point noise).
		const PREPEND_COUNT = 50;
		harness.setLoadOlderHandler(roomId, async () => {
			harness.prependEvents(roomId, manyEvents(PREPEND_COUNT, "$old"));
		});
		const m = mount(roomId);
		const scroller = m.getScroller();
		// Wait for initial bottom pin to land so we have a stable
		// scrollHeight to scroll up from.
		await expect
			.poll(() => distFromBottom(scroller), { timeout: 2000, interval: 50 })
			.toBeLessThan(2);
		// Scroll up to the middle and clear wantsBottom via wheel-up.
		// Setting scrollTop directly fires a scroll event whose
		// distFromBottom is large, so onScroll also clears wantsBottom;
		// the wheel handler reinforces the clear.
		scroller.scrollTop = Math.floor(
			(scroller.scrollHeight - scroller.clientHeight) / 2,
		);
		scroller.dispatchEvent(
			new WheelEvent("wheel", { deltaY: -50, bubbles: true }),
		);
		await frame();
		await frame();
		// Pick the first event currently visible in the viewport as the
		// anchor. Use a unique substring from the event body so we can
		// re-find the same row after prepend.
		const items = Array.from(
			scroller.querySelectorAll<HTMLElement>(":scope > div > div"),
		);
		const scrollerRect = scroller.getBoundingClientRect();
		const anchor = items.find((el) => {
			const r = el.getBoundingClientRect();
			return r.bottom > scrollerRect.top + 20 && r.top > scrollerRect.top;
		});
		if (!anchor) throw new Error("no anchor row found in viewport");
		const anchorText = anchor.textContent ?? "";
		const beforeTop = anchor.getBoundingClientRect().top;
		// Trigger paginateOlder by scrolling near the top.
		scroller.scrollTop = 50;
		await expect
			.poll(() => harness.loadOlderCallCount(roomId), {
				timeout: 2000,
				interval: 50,
			})
			.toBeGreaterThan(0);
		// Wait for the prepended rows to land in the DOM and Virtua to
		// relayout (rather than a fixed sleep).
		await expect
			.poll(
				() =>
					scroller.querySelectorAll<HTMLElement>(":scope > div > div").length,
				{ timeout: 2000, interval: 50 },
			)
			.toBeGreaterThan(items.length);
		// Re-find the anchor row in the (now larger) item list.
		const refoundItems = Array.from(
			scroller.querySelectorAll<HTMLElement>(":scope > div > div"),
		);
		const refound = refoundItems.find(
			(el) => (el.textContent ?? "") === anchorText,
		);
		if (!refound)
			throw new Error(`anchor row "${anchorText}" not found after prepend`);
		const afterTop = refound.getBoundingClientRect().top;
		// Shift wiring should keep the anchor within a small tolerance
		// of its previous viewport position. Without shift, the anchor
		// would have moved down by ~ PREPEND_COUNT * row height (many
		// hundreds of pixels).
		expect(Math.abs(afterTop - beforeTop)).toBeLessThan(20);
		m.unmount();
	});

	// Test 5: ArrowUp at the live end clears wantsBottom. Because the
	// scroller is *at* the bottom (distFromBottom < threshold),
	// onScroll's "scroll-away" path can't be the thing clearing
	// wantsBottom — only the keydown handler can.
	it("ArrowUp at bottom clears wantsBottom (next append does not snap)", async () => {
		const roomId = "!arrowUp:example.com";
		harness.setRoomState(roomId, { events: manyEvents(80, "$row") });
		const m = mount(roomId);
		const scroller = m.getScroller();
		await expect
			.poll(() => distFromBottom(scroller), {
				timeout: 2000,
				interval: 50,
			})
			.toBeLessThan(2);
		// Fire ArrowUp while still pinned at bottom — onScroll cannot
		// have cleared wantsBottom in this configuration because
		// distFromBottom < threshold (50px).
		scroller.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
		);
		await frame();
		await frame();
		const distBefore = distFromBottom(scroller);
		// Append a short event. With wantsBottom cleared, the bottom-
		// pin RAF should bail and distFromBottom should grow by the
		// new row's height.
		harness.appendEvents(roomId, [
			mkEvent("$post-arrow-up", "after arrow up", 1700000999999),
		]);
		await wait(150);
		const distAfter = distFromBottom(scroller);
		expect(distAfter).toBeGreaterThan(distBefore + 5);
		m.unmount();
	});

	// Test 6: wheel-down within 50px of the bottom re-arms
	// wantsBottom, so the next append snaps to the live end.
	it("re-arms on wheel-down within 50px of bottom", async () => {
		const roomId = "!rearmWheel:example.com";
		harness.setRoomState(roomId, { events: manyEvents(80, "$row") });
		const m = mount(roomId);
		const scroller = m.getScroller();
		await expect
			.poll(() => distFromBottom(scroller), {
				timeout: 2000,
				interval: 50,
			})
			.toBeLessThan(2);
		// Clear wantsBottom via ArrowUp at bottom.
		scroller.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
		);
		await frame();
		// Confirm the intent is cleared by appending and observing
		// no-snap behaviour.
		const beforeArm = distFromBottom(scroller);
		harness.appendEvents(roomId, [
			mkEvent("$pre-rearm", "before rearm", 1700000999000),
		]);
		await wait(100);
		expect(distFromBottom(scroller)).toBeGreaterThan(beforeArm + 5);
		// Now wheel-down within 50px of the bottom to re-arm.
		scroller.scrollTop = scroller.scrollHeight;
		scroller.dispatchEvent(
			new WheelEvent("wheel", { deltaY: 30, bubbles: true }),
		);
		await frame();
		harness.appendEvents(roomId, [
			mkEvent("$post-rearm", "after rearm", 1700000999500),
		]);
		await expect
			.poll(() => distFromBottom(scroller), {
				timeout: 2000,
				interval: 50,
			})
			.toBeLessThan(2);
		m.unmount();
	});

	// Test 7: clicking the scroll-to-bottom button re-arms
	// wantsBottom even after the user has scrolled up.
	it("re-arms on scroll-to-bottom button click", async () => {
		const roomId = "!jump:example.com";
		harness.setRoomState(roomId, { events: manyEvents(80, "$row") });
		const m = mount(roomId);
		const scroller = m.getScroller();
		await expect
			.poll(() => distFromBottom(scroller), {
				timeout: 2000,
				interval: 50,
			})
			.toBeLessThan(2);
		// Scroll up to surface the bottom button.
		scroller.scrollTop = 0;
		scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
		// Confirm the scroll-up actually committed before clicking the
		// button — otherwise the "wait for distFromBottom < 2" poll
		// below could pass immediately on a stale read, and we'd append
		// while jumpToLive's smooth scroll is still in flight.
		await expect
			.poll(() => distFromBottom(scroller), {
				timeout: 2000,
				interval: 50,
			})
			.toBeGreaterThan(100);
		await expect
			.poll(
				() =>
					!!m.container.querySelector<HTMLButtonElement>(
						'button[aria-label="Scroll to bottom"]',
					),
				{ timeout: 2000, interval: 50 },
			)
			.toBe(true);
		const btn = m.container.querySelector<HTMLButtonElement>(
			'button[aria-label="Scroll to bottom"]',
		);
		btn?.click();
		// Wait for jumpToLive's scroll animation to settle at the bottom
		// before appending — otherwise the append could race the in-
		// flight scroll and mask the rearm assertion.
		await expect
			.poll(() => distFromBottom(scroller), {
				timeout: 2000,
				interval: 50,
			})
			.toBeLessThan(2);
		// Append — with intent re-armed, scroller should snap back.
		harness.appendEvents(roomId, [
			mkEvent("$after-jump", "after jump", 1700000999999),
		]);
		await expect
			.poll(() => distFromBottom(scroller), {
				timeout: 2000,
				interval: 50,
			})
			.toBeLessThan(2);
		m.unmount();
	});
});
