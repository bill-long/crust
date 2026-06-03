import { createEffect, createSignal, onCleanup } from "solid-js";

/**
 * App-level modal stack counter.
 *
 * Why this exists: components that render non-modal but call-related UI
 * (`FullCallOverlay`, and in PR B-2b the `MiniCallWidget`) need to know
 * whether ANY app modal (`SettingsOverlay`, `RoomSettingsOverlay`,
 * `InviteDialog`, `CopyLinkFallbackDialog`, `ConfirmDialog`,
 * `ImageLightbox`) is currently open so they can mark themselves
 * `inert` and not steal keyboard / pointer interaction from the modal's
 * focus trap.
 *
 * `cryptoDialogOpen` already exists for the crypto-specific dialogs;
 * the consumer should OR these signals together (crypto dialogs are
 * allowed to stack on top of regular app modals, so they are tracked
 * separately).
 *
 * Each modal calls {@link pushAppModal} in `onMount` and
 * {@link popAppModal} in `onCleanup`. The counter approach lets
 * modals legitimately stack (e.g. a `ConfirmDialog` opened from within
 * `RoomSettingsOverlay`) without needing per-modal coordination.
 */

const [openCount, setOpenCount] = createSignal(0);

export function appModalOpen(): boolean {
	return openCount() > 0;
}

export function pushAppModal(): void {
	setOpenCount((n) => n + 1);
}

export function popAppModal(): void {
	setOpenCount((n) => Math.max(0, n - 1));
}

/** Test helper — resets the counter between tests. */
export function _resetAppModalStackForTests(): void {
	setOpenCount(0);
}

/**
 * Helper for modals whose mount-state IS their open-state (e.g.
 * `SettingsOverlay`, `RoomSettingsOverlay` rendered via a parent
 * `<Show>`). Call inside the component body. Pushes on mount, pops
 * on unmount.
 */
export function trackAppModalMounted(): void {
	pushAppModal();
	onCleanup(popAppModal);
}

/**
 * Helper for modals that stay mounted across open/close transitions
 * and gate their DOM with `<Show when={props.open()}>` (e.g.
 * `ConfirmDialog`, `InviteDialog`, `CopyLinkFallbackDialog`,
 * `ImageLightbox`). Call inside the component body with the same
 * open accessor that drives the `<Show>`. Tracks the open transition
 * via a local `pushed` flag so unmount-while-open also pops correctly.
 */
export function trackAppModalOpen(isOpen: () => boolean): void {
	let pushed = false;
	createEffect(() => {
		const open = isOpen();
		if (open && !pushed) {
			pushAppModal();
			pushed = true;
		} else if (!open && pushed) {
			popAppModal();
			pushed = false;
		}
	});
	onCleanup(() => {
		if (pushed) {
			popAppModal();
			pushed = false;
		}
	});
}
