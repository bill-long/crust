import { describe, expect, it } from "vitest";

/**
 * Settles a question that has come up in three review rounds of #450:
 * can the room list be kept mounted and merely hidden while search results
 * are showing, so it keeps its scroll position?
 *
 * `VirtualList` windows its rows from a `scrollTop` signal that only its DOM
 * scroll handler writes. If hiding an ancestor zeroed the scroller's
 * `scrollTop`, the list would come back rendering rows for an offset that no
 * longer exists. It does not: the offset survives, so hiding is strictly
 * better than unmounting.
 *
 * Asserted in a real browser because jsdom does not lay out or scroll.
 */
describe("display:none and scrollTop", () => {
	it("keeps a descendant scroller's offset when an ancestor hides", async () => {
		const wrapper = document.createElement("div");
		const scroller = document.createElement("div");
		const content = document.createElement("div");
		scroller.style.height = "100px";
		scroller.style.overflowY = "auto";
		content.style.height = "1000px";
		scroller.appendChild(content);
		wrapper.appendChild(scroller);
		document.body.appendChild(wrapper);

		scroller.scrollTop = 400;
		expect(scroller.scrollTop).toBe(400);

		let sawScrollEvent = false;
		scroller.addEventListener("scroll", () => {
			sawScrollEvent = true;
		});

		wrapper.style.display = "none";
		// Force layout while hidden.
		void wrapper.offsetHeight;
		wrapper.style.display = "";
		void wrapper.offsetHeight;
		// Scroll events are dispatched at the next rendering opportunity, so
		// asserting `sawScrollEvent` synchronously proved nothing whatever
		// the browser did. Wait two frames for one to arrive if it is going
		// to.
		await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
		await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

		// The answer, and the only part that decides anything: Chromium
		// preserves the offset across display:none. So hiding is safe - the
		// list comes back exactly where it was.
		//
		// This contradicts what four #450 review rounds asserted, including
		// the commit that reverted hiding in favour of unmounting. That
		// reasoning was never tested; this is why it is a browser test.
		expect(scroller.scrollTop).toBe(400);
		// Whether a scroll event fires is deliberately not asserted. It does
		// today, one frame later, but nothing depends on it: `VirtualList`
		// reads `scrollTop` from the DOM in that handler, and the DOM
		// already holds the right value. Pinning incidental behaviour would
		// fail this test for a browser that reasonably fires nothing for an
		// unchanged offset.
		void sawScrollEvent;

		document.body.removeChild(wrapper);
	});
});
