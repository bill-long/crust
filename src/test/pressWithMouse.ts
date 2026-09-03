import { fireEvent } from "@solidjs/testing-library";

/**
 * Activate a Kobalte control the way a mouse does.
 *
 * Kobalte acts on pointer events, which jsdom does not synthesize from a
 * plain `click`, so every menu test fires the pointer sequence itself. The
 * load-bearing detail is `button: 0` surviving into a real `PointerEvent`:
 * jsdom 30 ships one, and Kobalte's menu item selects on the `pointerup`
 * that carries it. Do NOT add an Enter keydown "as well" - that was the idiom
 * when pointer events were inert here, and on a real `PointerEvent` it
 * counts as a second activation.
 */
export function pressWithMouse(el: Element): void {
	fireEvent.pointerMove(el, { pointerType: "mouse" });
	fireEvent.pointerDown(el, { button: 0, pointerType: "mouse" });
	fireEvent.pointerUp(el, { button: 0, pointerType: "mouse" });
	fireEvent.click(el);
}
