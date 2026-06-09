import { createSignal } from "solid-js";
import { isNativeShell } from "../../../../app/nativeShell";
import { invokeTauri } from "../../../../app/tauri";

/**
 * Controls the native desktop overlay WINDOW (the second, always-on-top Tauri
 * window that renders the `/overlay` route). This is the native-shell
 * counterpart to the Document Picture-in-Picture overlay used in browsers:
 * `CallStatusPanel` chooses between them via `isNativeShell()`.
 *
 * The window itself is owned by Rust (`open_overlay` / `close_overlay`
 * commands); this module only tracks an optimistic open/close signal for the
 * trigger button. The live call data shown in the window is bridged separately
 * over the BroadcastChannel by `CallOverlayBroadcaster`, independent of this.
 */

const [nativeOverlayOpenSignal, setNativeOverlayOpen] = createSignal(false);

/** Reactive: true while the native overlay window is (believed) open. */
export function nativeOverlayOpen(): boolean {
	return nativeOverlayOpenSignal();
}

/** Open the native overlay window (idempotent on the Rust side). */
export async function openNativeOverlay(): Promise<void> {
	// Only the native shell has the overlay window; outside it, don't flip the
	// optimistic signal (the invoke is a no-op there and nothing actually opens).
	if (!isNativeShell()) return;
	try {
		await invokeTauri("open_overlay");
		setNativeOverlayOpen(true);
	} catch (err) {
		console.error("openNativeOverlay failed", err);
	}
}

/** Close the native overlay window (idempotent on the Rust side). */
export async function closeNativeOverlay(): Promise<void> {
	if (!isNativeShell()) return;
	try {
		await invokeTauri("close_overlay");
		setNativeOverlayOpen(false);
	} catch (err) {
		console.error("closeNativeOverlay failed", err);
	}
}

/**
 * Reconcile the signal with the actual window state (the user can close the
 * overlay from its own chrome or a global hotkey, which this window can't
 * observe directly). Call on mount, on window focus, and before toggling.
 */
export async function syncNativeOverlayOpen(): Promise<void> {
	if (!isNativeShell()) return;
	try {
		const open = await invokeTauri<boolean>("overlay_is_open");
		setNativeOverlayOpen(open === true);
	} catch (err) {
		console.error("syncNativeOverlayOpen failed", err);
	}
}

/** Test helper — reset module state between tests. */
export function _resetNativeOverlayForTests(): void {
	setNativeOverlayOpen(false);
}
