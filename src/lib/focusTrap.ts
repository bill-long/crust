import { createEffect, onCleanup } from "solid-js";

/**
 * Canonical focus selector and boundary navigation used by Modal.
 * The non-modal full-call region also uses the selector for initial focus.
 * New dialogs should use components/Modal rather than wire these directly.
 */

export const FOCUSABLE_SELECTOR =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keep Tab/Shift+Tab cycling inside `container`. Call from the container's
 * keydown handler for "Tab" events; visibility is approximated by
 * offsetParent, matching the existing dialogs.
 */
export function trapTabKey(container: HTMLElement, e: KeyboardEvent): void {
	const focusable = Array.from(
		container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
	).filter(
		(el) => el.offsetParent !== null && !el.hasAttribute("data-focus-trap"),
	);
	if (focusable.length === 0) return;
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	if (!first || !last) return;
	if (e.shiftKey && document.activeElement === first) {
		e.preventDefault();
		last.focus();
	} else if (!e.shiftKey && document.activeElement === last) {
		e.preventDefault();
		first.focus();
	}
}

/**
 * Modal focus containment: while `open`, recapture focus that lands
 * outside the modal's overlay. An opener can asynchronously restore focus
 * to itself after the modal took its initial focus - e.g. Kobalte's
 * dropdown menu refocuses its trigger on a timer after its
 * presence-deferred unmount (unconditional in 0.13; onCloseAutoFocus
 * can't prevent it) - which would strand the overlay-scoped Escape/Tab
 * handling outside the dialog.
 *
 * A focusin whose target sits inside a DIFFERENT `aria-modal` surface is
 * deliberately left alone: crypto dialogs legitimately stack on top of
 * app modals, and two containment-enabled modals must never fight over
 * focus - a mutual recapture would recurse through synchronous focusin
 * dispatch to a stack overflow. With the gate, an outside-of-everything
 * focus settles after at most one hop per open modal.
 *
 * Call from the component body (needs a reactive owner); the listener
 * detaches when `open` flips false or the owner is disposed.
 * @deprecated All app dialogs now use Modal's Kobalte-backed containment.
 */
export function containFocusWhileOpen(
	open: () => boolean,
	getOverlay: () => HTMLElement | undefined,
	getFocusTarget: () => HTMLElement | undefined,
): void {
	createEffect(() => {
		if (!open()) return;
		const onFocusIn = (e: FocusEvent): void => {
			const overlay = getOverlay();
			const target = e.target;
			if (!overlay || !(target instanceof Element)) return;
			if (overlay.contains(target)) return;
			if (target.closest('[aria-modal="true"]') !== null) return;
			getFocusTarget()?.focus();
			// The preferred target may be unable to take focus (e.g. a
			// confirm button disabled while its action is pending) - fall
			// back to the overlay itself, which carries tabIndex={-1}, so
			// containment never silently fails.
			if (!overlay.contains(document.activeElement)) overlay.focus();
		};
		document.addEventListener("focusin", onFocusIn);
		onCleanup(() => document.removeEventListener("focusin", onFocusIn));
	});
}
