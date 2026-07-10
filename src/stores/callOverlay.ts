import { createSignal } from "solid-js";
import { loadPersisted, savePersisted } from "../lib/persistedSignal";
import { STORAGE_KEYS } from "../lib/storageKeys";

/**
 * Global state for the floating voice-overlay panel (a Document
 * Picture-in-Picture window that mirrors the active call's participants so the
 * user can watch who is talking without alt-tabbing out of a game/full-screen
 * app).
 *
 * The PiP *window lifecycle* is owned by `CallOverlayController` (mounted in
 * `PersistentCallSurface`, above the per-route `Layout`, so it survives
 * navigation — exactly like the call session itself). This module only holds
 * the small shared state the trigger button and the controller coordinate on:
 *
 *   - `overlayOpen()` — reactive: true while a PiP window is open. The trigger
 *     button reflects this; the controller flips it as the window opens/closes.
 *   - the live `Window` reference (non-reactive — only the controller touches
 *     it, to render into / close it).
 *   - the persisted preferred size, so the window reopens at the user's last
 *     chosen dimensions.
 *
 * Only one PiP window can exist per browser, matching this single-signal model.
 */

const SIZE_KEY = STORAGE_KEYS.callOverlaySize;

export interface OverlaySize {
	width: number;
	height: number;
}

/** Default PiP window size when nothing valid is persisted. */
export const DEFAULT_OVERLAY_SIZE: OverlaySize = { width: 280, height: 360 };

/** Clamp persisted/requested sizes to a sane on-screen range. */
const MIN_DIMENSION = 180;
const MAX_DIMENSION = 1200;

function isValidDimension(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= MIN_DIMENSION &&
		value <= MAX_DIMENSION
	);
}

/** Read the persisted preferred size, falling back to the default. */
export function loadOverlaySize(): OverlaySize {
	return loadPersisted(
		SIZE_KEY,
		(raw): OverlaySize => {
			if (typeof raw !== "object" || raw === null) {
				return { ...DEFAULT_OVERLAY_SIZE };
			}
			const obj = raw as Record<string, unknown>;
			if (isValidDimension(obj.width) && isValidDimension(obj.height)) {
				return { width: obj.width, height: obj.height };
			}
			return { ...DEFAULT_OVERLAY_SIZE };
		},
		{ ...DEFAULT_OVERLAY_SIZE },
	);
}

/** Persist the user's preferred overlay size (best-effort; ignores invalid). */
export function saveOverlaySize(size: OverlaySize): void {
	if (!isValidDimension(size.width) || !isValidDimension(size.height)) return;
	savePersisted(SIZE_KEY, size);
}

const [overlayOpenSignal, setOverlayOpenSignal] = createSignal(false);

// Non-reactive: only the controller reads/writes the concrete window handle.
let pipWindow: Window | null = null;

/** Reactive: true while the overlay PiP window is open. */
export function overlayOpen(): boolean {
	return overlayOpenSignal();
}

/** The live PiP window, or null when closed. Controller-only. */
export function overlayWindow(): Window | null {
	return pipWindow;
}

/**
 * Record that the controller has opened a PiP window. Stores the handle and
 * flips `overlayOpen()` to true.
 */
export function setOverlayWindow(win: Window): void {
	pipWindow = win;
	setOverlayOpenSignal(true);
}

/**
 * Clear the stored window handle and flip `overlayOpen()` to false. Called by
 * the controller after the window has been closed/torn down. Idempotent.
 */
export function clearOverlayWindow(): void {
	pipWindow = null;
	setOverlayOpenSignal(false);
}

// Pluggable open/close handlers, registered by `CallOverlayController` while it
// is mounted. Keeping the actual PiP window machinery in the controller (rather
// than here) lets this module stay free of DOM/lifecycle concerns and testable.
let openHandler: (() => void) | null = null;
let closeHandler: (() => void) | null = null;

/** Register the controller's open/close handlers. Pass nulls to unregister. */
export function setOverlayHandlers(
	open: (() => void) | null,
	close: (() => void) | null,
): void {
	openHandler = open;
	closeHandler = close;
}

/**
 * Request the overlay open. Must be called from a user gesture (the PiP API
 * requires one). No-op if the controller isn't mounted (no active call).
 */
export function requestOpenOverlay(): void {
	openHandler?.();
}

/** Request the overlay close. No-op if not open / controller not mounted. */
export function closeOverlay(): void {
	closeHandler?.();
}

/** Test helper — resets module-level state between tests. */
export function _resetCallOverlayForTests(): void {
	pipWindow = null;
	openHandler = null;
	closeHandler = null;
	setOverlayOpenSignal(false);
}
