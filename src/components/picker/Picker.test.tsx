import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import { createPicker } from "./Picker";

afterEach(cleanup);

// jsdom has no layout engine, so stub a 216px viewport (the popover's
// max-h, 6 rows of 36px) to exercise the windowed list - mirrors the
// VirtualList test's approach.
const restore: Array<() => void> = [];

beforeEach(() => {
	const desc = Object.getOwnPropertyDescriptor(
		HTMLElement.prototype,
		"clientHeight",
	);
	Object.defineProperty(HTMLElement.prototype, "clientHeight", {
		configurable: true,
		get: () => 216,
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

const ITEMS = Array.from({ length: 100 }, (_, i) => `item-${i}`);

function setup(options?: { items?: string[]; query?: string }) {
	const picker = createPicker<string>();
	const onSelect = vi.fn();
	const onClose = vi.fn();
	const [visible, setVisible] = createSignal(true);
	const [query, setQuery] = createSignal(options?.query ?? "");
	const utils = render(() => (
		<picker.Picker
			items={options?.items ?? ITEMS}
			query={query()}
			visible={visible()}
			position={{ bottom: "auto", left: "0" }}
			onSelect={onSelect}
			onClose={onClose}
			filterFn={(item, q) => item.includes(q.trim().toLowerCase())}
			renderItem={(item) => <span>{item}</span>}
		/>
	));
	const key = (k: string): boolean =>
		picker.handlePickerKey(new KeyboardEvent("keydown", { key: k }));
	return { picker, onSelect, onClose, setVisible, setQuery, key, ...utils };
}

describe("createPicker windowing", () => {
	it("mounts only the rows near the viewport, not the whole item set", () => {
		const { queryByText } = setup();
		expect(queryByText("item-0")).toBeTruthy();
		// 216px / 36px = 6 visible rows + 3 overscan; row 50 is far outside.
		expect(queryByText("item-50")).toBeNull();
	});

	it("keeps the full scroll height via the spacer", () => {
		const { container } = setup();
		const listbox = container.querySelector('[role="listbox"]');
		const spacer = listbox?.firstElementChild as HTMLElement;
		expect(spacer.style.height).toBe(`${100 * 36}px`);
	});

	it("ArrowDown walks past the windowed boundary, keeping the highlighted row mounted and aria-resolvable", () => {
		const { picker, key, queryByText } = setup();
		for (let i = 0; i < 20; i++) key("ArrowDown");
		expect(queryByText("item-20")).toBeTruthy();
		const active = picker.getActiveDescendant();
		expect(active).toBe(`${picker.listboxId}-item-20`);
		const el = active ? document.getElementById(active) : null;
		expect(el).toBeTruthy();
		expect(el?.getAttribute("aria-selected")).toBe("true");
	});

	it("ArrowUp from the top wraps to the last item and scrolls it into view", () => {
		const { picker, key, container, queryByText } = setup();
		expect(queryByText("item-99")).toBeNull();
		key("ArrowUp");
		expect(queryByText("item-99")).toBeTruthy();
		const active = picker.getActiveDescendant();
		expect(active).toBe(`${picker.listboxId}-item-99`);
		expect(document.getElementById(active as string)).toBeTruthy();
		const listbox = container.querySelector('[role="listbox"]') as HTMLElement;
		// Bottom-aligned: 100 rows * 36px minus the 216px viewport.
		expect(listbox.scrollTop).toBe(100 * 36 - 216);
	});

	it("Enter selects the highlighted item across the boundary", () => {
		const { key, onSelect } = setup();
		key("ArrowUp"); // wrap to item-99
		key("Enter");
		expect(onSelect).toHaveBeenCalledWith("item-99");
	});

	it("mouseDown on a row selects it", () => {
		const { getByText, onSelect } = setup();
		fireEvent.mouseDown(getByText("item-3"));
		expect(onSelect).toHaveBeenCalledWith("item-3");
	});

	it("clamps the highlight when the query narrows the list", () => {
		const { picker, key, setQuery, queryByText } = setup();
		key("ArrowUp"); // highlight item-99
		setQuery("item-1"); // matches item-1, item-10..19: 11 items
		expect(picker.getActiveDescendant()).toBe(`${picker.listboxId}-item-10`);
		expect(queryByText("item-19")).toBeTruthy();
	});

	it("resets the highlight to the top when the picker reopens", () => {
		const { picker, key, setVisible, queryByText } = setup();
		key("ArrowUp"); // highlight item-99
		setVisible(false);
		expect(queryByText("item-0")).toBeNull();
		setVisible(true);
		expect(picker.getActiveDescendant()).toBe(`${picker.listboxId}-item-0`);
		expect(queryByText("item-0")).toBeTruthy();
	});

	it("keeps Escape close behavior with no matches", () => {
		const { key, onClose, setQuery } = setup();
		setQuery("zzz");
		expect(key("Escape")).toBe(true);
		expect(onClose).toHaveBeenCalled();
	});
});
