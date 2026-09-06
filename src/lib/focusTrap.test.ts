import { afterEach, describe, expect, it } from "vitest";
import { requiredAt } from "../test/assertions";
import { FOCUSABLE_SELECTOR, trapTabKey } from "./focusTrap";

// trapTabKey filters candidates by `offsetParent !== null` to approximate
// visibility. jsdom has no layout engine, so offsetParent is always null and
// every element would be filtered out. Force it to a non-null value for the
// elements we want the trap to see.
function makeVisible(el: HTMLElement): void {
	Object.defineProperty(el, "offsetParent", {
		configurable: true,
		get: () => document.body,
	});
}

let container: HTMLDivElement | undefined;

afterEach(() => {
	container?.remove();
	container = undefined;
});

/** Build a container with `count` focusable buttons, all marked visible. */
function mountButtons(count: number): HTMLButtonElement[] {
	container = document.createElement("div");
	const buttons: HTMLButtonElement[] = [];
	for (let i = 0; i < count; i++) {
		const b = document.createElement("button");
		b.textContent = `b${i}`;
		makeVisible(b);
		container.appendChild(b);
		buttons.push(b);
	}
	document.body.appendChild(container);
	return buttons;
}

function tabEvent(shift: boolean): KeyboardEvent {
	return new KeyboardEvent("keydown", {
		key: "Tab",
		shiftKey: shift,
		bubbles: true,
		cancelable: true,
	});
}

describe("FOCUSABLE_SELECTOR", () => {
	it("matches enabled interactive elements and skips disabled / tabindex=-1", () => {
		const root = document.createElement("div");
		root.innerHTML = `
			<button>ok</button>
			<button disabled>no</button>
			<a href="#">link</a>
			<input />
			<input disabled />
			<div tabindex="0">focusable div</div>
			<div tabindex="-1">skipped div</div>
			<div>plain</div>
		`;
		const matched = Array.from(
			root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
		);
		expect(matched.map((el) => el.textContent?.trim() || el.tagName)).toEqual([
			"ok",
			"link",
			"INPUT",
			"focusable div",
		]);
	});
});

describe("trapTabKey", () => {
	it("wraps focus from the last element to the first on Tab", () => {
		const buttons = mountButtons(3);
		const first = requiredAt(buttons, 0, "first button");
		const last = requiredAt(buttons, 2, "last button");
		last.focus();
		expect(document.activeElement).toBe(last);

		const e = tabEvent(false);
		trapTabKey(container as HTMLElement, e);

		expect(document.activeElement).toBe(first);
		expect(e.defaultPrevented).toBe(true);
	});

	it("wraps focus from the first element to the last on Shift+Tab", () => {
		const buttons = mountButtons(3);
		const first = requiredAt(buttons, 0, "first button");
		const last = requiredAt(buttons, 2, "last button");
		first.focus();

		const e = tabEvent(true);
		trapTabKey(container as HTMLElement, e);

		expect(document.activeElement).toBe(last);
		expect(e.defaultPrevented).toBe(true);
	});

	it("does nothing when focus is in the middle (lets the browser advance)", () => {
		const buttons = mountButtons(3);
		const middle = requiredAt(buttons, 1, "middle button");
		middle.focus();

		const e = tabEvent(false);
		trapTabKey(container as HTMLElement, e);

		expect(document.activeElement).toBe(middle);
		expect(e.defaultPrevented).toBe(false);
	});

	it("is a no-op when the container has no focusable elements", () => {
		container = document.createElement("div");
		container.innerHTML = "<span>text only</span>";
		document.body.appendChild(container);

		const e = tabEvent(false);
		expect(() => trapTabKey(container as HTMLElement, e)).not.toThrow();
		expect(e.defaultPrevented).toBe(false);
	});

	it("treats a single focusable element as both first and last", () => {
		const buttons = mountButtons(1);
		const only = requiredAt(buttons, 0, "only button");
		only.focus();

		const forward = tabEvent(false);
		trapTabKey(container as HTMLElement, forward);
		expect(document.activeElement).toBe(only);
		expect(forward.defaultPrevented).toBe(true);

		const backward = tabEvent(true);
		trapTabKey(container as HTMLElement, backward);
		expect(document.activeElement).toBe(only);
		expect(backward.defaultPrevented).toBe(true);
	});

	it("ignores elements hidden via a null offsetParent", () => {
		const buttons = mountButtons(3);
		const first = requiredAt(buttons, 0, "first button");
		const middle = requiredAt(buttons, 1, "middle button");
		const last = requiredAt(buttons, 2, "last button");
		// Hide the real last button; the trap should now treat buttons[1] as last.
		Object.defineProperty(last, "offsetParent", {
			configurable: true,
			get: () => null,
		});
		middle.focus();

		const e = tabEvent(false);
		trapTabKey(container as HTMLElement, e);

		expect(document.activeElement).toBe(first);
		expect(e.defaultPrevented).toBe(true);
	});
});
