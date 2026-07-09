import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import { computeRowOffsets, VirtualList, visibleRowRange } from "./VirtualList";

afterEach(cleanup);

describe("computeRowOffsets", () => {
	it("builds a prefix sum for a uniform height", () => {
		expect(computeRowOffsets(3, 10)).toEqual([0, 10, 20, 30]);
	});

	it("builds a prefix sum for per-row heights", () => {
		const h = [5, 10, 15, 20];
		expect(computeRowOffsets(4, (i) => h[i])).toEqual([0, 5, 15, 30, 50]);
	});

	it("returns [0] for an empty list", () => {
		expect(computeRowOffsets(0, 10)).toEqual([0]);
	});
});

describe("visibleRowRange", () => {
	const uniform = computeRowOffsets(100, 10); // rows of 10px, total 1000

	it("selects the rows overlapping the viewport (no overscan)", () => {
		// viewport [0,50] overlaps rows 0..4; row 5 starts exactly at 50.
		expect(visibleRowRange(uniform, 0, 50, 0)).toEqual([0, 5]);
	});

	it("selects an interior window", () => {
		expect(visibleRowRange(uniform, 100, 50, 0)).toEqual([10, 15]);
	});

	it("grows the window by overscan on both sides and clamps", () => {
		expect(visibleRowRange(uniform, 100, 50, 3)).toEqual([7, 18]);
	});

	it("clamps at the top", () => {
		expect(visibleRowRange(uniform, 0, 50, 3)).toEqual([0, 8]);
	});

	it("clamps at the bottom", () => {
		// Scrolled to the last rows; last must not exceed the row count.
		expect(visibleRowRange(uniform, 990, 50, 3)).toEqual([96, 100]);
	});

	it("renders at least one row (plus overscan) before measurement (viewportH=0)", () => {
		// Guards the popover-mount case: a 0px viewport must not render empty.
		expect(visibleRowRange(uniform, 0, 0, 3)).toEqual([0, 4]);
	});

	it("returns an empty range for an empty list", () => {
		expect(visibleRowRange([0], 0, 100, 3)).toEqual([0, 0]);
	});

	it("handles variable row heights", () => {
		const offs = computeRowOffsets(4, (i) => [5, 10, 15, 20][i]); // [0,5,15,30,50]
		// viewport [12,22] overlaps rows 1 (5-15) and 2 (15-30).
		expect(visibleRowRange(offs, 12, 10, 0)).toEqual([1, 3]);
	});
});

describe("<VirtualList>", () => {
	it("renders the fallback when empty and forwards attributes", () => {
		const { container, getByText } = render(() => (
			<VirtualList
				each={[]}
				rowHeight={10}
				class="scroller"
				aria-label="Items"
				fallback={<span>Nothing here</span>}
			>
				{(item: string) => <div>{item}</div>}
			</VirtualList>
		));
		expect(getByText("Nothing here")).toBeTruthy();
		const scroller = container.querySelector(".scroller");
		expect(scroller).toBeTruthy();
		expect(scroller?.getAttribute("aria-label")).toBe("Items");
	});

	it("mounts rows and reserves full scroll height via the spacer", () => {
		const items = Array.from({ length: 50 }, (_, i) => `row-${i}`);
		const { container, getByText } = render(() => (
			<VirtualList each={items} rowHeight={10} overscan={2}>
				{(item: string) => <div>{item}</div>}
			</VirtualList>
		));
		// The first rows are mounted (jsdom viewport is 0, so first + overscan).
		expect(getByText("row-0")).toBeTruthy();
		// The spacer reserves the full 50 * 10 = 500px height.
		const spacer = container.querySelector<HTMLElement>("div > div > div");
		expect(spacer?.style.height).toBe("500px");
	});
});

describe("<VirtualList> windowing with a stubbed viewport", () => {
	// jsdom has no layout engine (clientHeight is always 0 and ResizeObserver
	// is absent), so stub a fixed 50px viewport to exercise the scroll window.
	const restore: Array<() => void> = [];
	// Stable object refs so <For> keys by reference, mirroring the real usage
	// (rows of emoji) rather than the primitive-dedupe fast path.
	const items = Array.from({ length: 100 }, (_, i) => ({ n: i }));

	beforeEach(() => {
		const desc = Object.getOwnPropertyDescriptor(
			HTMLElement.prototype,
			"clientHeight",
		);
		Object.defineProperty(HTMLElement.prototype, "clientHeight", {
			configurable: true,
			get: () => 50,
		});
		restore.push(() => {
			if (desc)
				Object.defineProperty(HTMLElement.prototype, "clientHeight", desc);
		});
		const g = globalThis as { ResizeObserver?: unknown };
		if (typeof g.ResizeObserver === "undefined") {
			g.ResizeObserver = class {
				observe(): void {}
				unobserve(): void {}
				disconnect(): void {}
			};
			restore.push(() => {
				g.ResizeObserver = undefined;
			});
		}
	});

	afterEach(() => {
		for (const f of restore.splice(0)) f();
	});

	function renderList() {
		return render(() => (
			<VirtualList each={items} rowHeight={10} overscan={2} class="scroller">
				{(item: { n: number }) => <div>{`row-${item.n}`}</div>}
			</VirtualList>
		));
	}

	it("mounts only the rows overlapping the viewport (plus overscan)", () => {
		const { queryByText } = renderList();
		// viewport 50 / row 10 = 5 rows, + overscan 2 => rows 0..6.
		expect(queryByText("row-0")).toBeTruthy();
		expect(queryByText("row-6")).toBeTruthy();
		expect(queryByText("row-7")).toBeNull();
		expect(queryByText("row-40")).toBeNull();
	});

	it("does not remount an in-window row on a sub-row scroll", () => {
		const { container, getByText } = renderList();
		const scroller = container.querySelector(".scroller") as HTMLElement;
		const before = getByText("row-2");
		scroller.scrollTop = 4; // < rowHeight, row 2 stays in the window
		scroller.dispatchEvent(new Event("scroll"));
		// Same DOM node instance => the stable-ref <For> kept it (no churn).
		expect(getByText("row-2")).toBe(before);
	});

	it("shifts the window on a larger scroll", () => {
		const { container, queryByText } = renderList();
		const scroller = container.querySelector(".scroller") as HTMLElement;
		scroller.scrollTop = 100; // 10 rows down
		scroller.dispatchEvent(new Event("scroll"));
		expect(queryByText("row-0")).toBeNull();
		expect(queryByText("row-12")).toBeTruthy();
	});

	it("merges a forwarded onScroll without breaking the window update", () => {
		const onScroll = vi.fn();
		const { container, queryByText } = render(() => (
			<VirtualList
				each={items}
				rowHeight={10}
				overscan={2}
				class="scroller"
				onScroll={onScroll}
			>
				{(item: { n: number }) => <div>{`row-${item.n}`}</div>}
			</VirtualList>
		));
		const scroller = container.querySelector(".scroller") as HTMLElement;
		scroller.scrollTop = 100;
		scroller.dispatchEvent(new Event("scroll"));
		expect(onScroll).toHaveBeenCalledTimes(1); // caller's handler still runs
		expect(queryByText("row-0")).toBeNull(); // and the window still shifted
		expect(queryByText("row-12")).toBeTruthy();
	});

	it("forwards a ref to the scroll container", () => {
		let el: HTMLElement | undefined;
		const { container } = render(() => (
			<VirtualList
				each={items}
				rowHeight={10}
				class="scroller"
				ref={(e: HTMLDivElement) => {
					el = e;
				}}
			>
				{(item: { n: number }) => <div>{`row-${item.n}`}</div>}
			</VirtualList>
		));
		expect(el).toBe(container.querySelector(".scroller"));
	});
});
