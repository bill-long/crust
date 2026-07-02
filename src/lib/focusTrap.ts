/**
 * Shared pieces of the hand-rolled modal focus trap used by the app's
 * stay-mounted dialogs (see CreateRoomDialog for the originating pattern).
 *
 * Extracted so new dialogs stop copying the selector + Tab-cycling logic
 * verbatim - CreatePollDialog is the first consumer; migrating the ten
 * older copies is part of the shared-Modal consolidation (#309).
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
	).filter((el) => el.offsetParent !== null);
	if (focusable.length === 0) return;
	const first = focusable[0];
	const last = focusable[focusable.length - 1];
	if (e.shiftKey && document.activeElement === first) {
		e.preventDefault();
		last.focus();
	} else if (!e.shiftKey && document.activeElement === last) {
		e.preventDefault();
		first.focus();
	}
}
