import { type Component, getOwner, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import {
	clearOverlayWindow,
	loadOverlaySize,
	overlayWindow,
	saveOverlaySize,
	setOverlayHandlers,
	setOverlayWindow,
} from "../../../../stores/callOverlay";
import { CallOverlayPanel } from "./CallOverlayPanel";
import { copyStylesIntoPipDocument } from "./pipStyles";
import { getDocumentPip } from "./pipSupport";

/**
 * Owns the Document Picture-in-Picture *window lifecycle* for the floating
 * voice overlay. Mounted by `PersistentCallSurface` only while a call is active
 * (inside its keyed `<Show>`), so the controller — and therefore the overlay —
 * is automatically torn down when the call ends (the `<Show>` unmounts, running
 * `onCleanup`).
 *
 * Renders nothing in the main document. It registers open/close handlers in the
 * `callOverlay` store so the sidebar trigger button can drive it, then manages
 * the actual PiP window: opening it from a user gesture, copying the app's
 * styles into it, rendering `<CallOverlayPanel>` into it, and tearing
 * everything down idempotently.
 *
 * Lifecycle invariants (verified via rubber-duck against Solid internals):
 *   - `requestWindow()` is called synchronously inside the user-gesture call
 *     stack (trigger click → store.requestOpenOverlay → this open handler →
 *     requestWindow). No effect/await boundary precedes it, preserving the
 *     required user activation.
 *   - Opening is re-entrancy guarded (in-flight promise + existing-window
 *     check) so a double-click can't race two windows.
 *   - Teardown is a single idempotent function. It nulls refs first, removes
 *     the `pagehide` listener BEFORE any programmatic `close()` (so the
 *     listener can't re-enter teardown), then disposes the Solid root.
 */
export const CallOverlayController: Component = () => {
	const owner = getOwner();

	let pipWindow: Window | null = null;
	let disposePanel: (() => void) | null = null;
	let pagehideHandler: (() => void) | null = null;
	let resizeHandler: (() => void) | null = null;
	let openInFlight = false;
	// Set once the controller unmounts (call ended/switched). A pending
	// `requestWindow()` may still resolve afterwards; we must discard it.
	let destroyed = false;
	// Bumped on every open and on every teardown so an in-flight
	// `requestWindow()` whose generation no longer matches is discarded.
	let openGeneration = 0;

	/**
	 * Idempotent teardown. `closeWindow` is true when WE end the overlay (call
	 * ended / controller unmount) and must close the window; false when the
	 * window is already going away (user closed it → `pagehide`).
	 */
	const teardown = (closeWindow: boolean): void => {
		// Invalidate any in-flight open so its `.then` discards the window it
		// is about to create instead of surfacing a stale overlay.
		openGeneration++;

		const win = pipWindow;
		const dispose = disposePanel;
		const onPagehide = pagehideHandler;
		const onResize = resizeHandler;

		pipWindow = null;
		disposePanel = null;
		pagehideHandler = null;
		resizeHandler = null;
		clearOverlayWindow();

		if (win && onPagehide) win.removeEventListener("pagehide", onPagehide);
		if (win && onResize) win.removeEventListener("resize", onResize);

		dispose?.();

		if (closeWindow && win && !win.closed) {
			win.close();
		}
	};

	const open = (): void => {
		if (destroyed) return;
		if (openInFlight) return;
		const existing = overlayWindow();
		if (existing && !existing.closed) {
			existing.focus();
			return;
		}
		const pip = getDocumentPip();
		if (!pip) return;
		// If a PiP window already exists at the API level, don't request another.
		if (pip.window && !pip.window.closed) return;

		openInFlight = true;
		const generation = ++openGeneration;
		const size = loadOverlaySize();
		// Call requestWindow synchronously within the gesture; do not await
		// anything before it (user-activation requirement).
		pip
			.requestWindow({ width: size.width, height: size.height })
			.then((win) => {
				// The controller may have been torn down (call ended/switched), or
				// a newer open/teardown may have superseded this request, while
				// requestWindow was in flight. Discard the window rather than
				// surfacing a stale overlay owned by a disposed controller.
				if (destroyed || generation !== openGeneration) {
					try {
						win.close();
					} catch {
						// Window may already be closing; nothing actionable.
					}
					return;
				}
				pipWindow = win;
				try {
					win.document.title = "Crust — Voice";
					copyStylesIntoPipDocument(document, win.document);

					disposePanel = render(
						() => <CallOverlayPanel />,
						win.document.body,
						undefined,
						{ owner },
					);

					pagehideHandler = (): void => teardown(false);
					win.addEventListener("pagehide", pagehideHandler);

					// Persist the user's chosen size so the overlay reopens at it.
					resizeHandler = (): void => {
						saveOverlaySize({
							width: win.innerWidth,
							height: win.innerHeight,
						});
					};
					win.addEventListener("resize", resizeHandler);

					setOverlayWindow(win);
				} catch {
					// Setup failed after the window opened (e.g. style copy or
					// render threw). Tear down whatever partial state was wired up
					// and close the window so it can't leak as an orphan.
					teardown(true);
				}
			})
			.catch(() => {
				// NotAllowedError (lost activation), user dismissed, or unsupported.
				// Leave state closed; the trigger can be clicked again.
			})
			.finally(() => {
				openInFlight = false;
			});
	};

	const close = (): void => {
		teardown(true);
	};

	onMount(() => {
		setOverlayHandlers(open, close);
	});

	onCleanup(() => {
		destroyed = true;
		setOverlayHandlers(null, null);
		teardown(true);
	});

	return null;
};
