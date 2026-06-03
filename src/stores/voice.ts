import { type Accessor, createMemo, createSignal } from "solid-js";
import { userSettings } from "./settings";

/**
 * Global voice intent store (Phase 6 of #122 — issue #108).
 *
 * Unifies "should the mic be transmitting?" across the UserBar mic
 * button, the in-call mute button (`FullCallOverlay`), and the global
 * push-to-talk / push-to-mute hotkey (`useGlobalMicHotkey`). The
 * single derived `micEnabled` accessor drives the LiveKit room wrapper
 * (`useLivekitRoom`), eliminating dual-writer races between the
 * imperative pre-Phase-6 `setLocalMuted` API and the new hotkey path.
 *
 * Persistence:
 * - `micMode` and `micHotkey` live in `userSettings()` (localStorage).
 * - `userWantsMicOn` and `hotkeyHeld` are intentionally transient.
 *   Refresh resets manual mute (Discord behavior); a held key is
 *   never persistent state.
 */

// `userWantsMicOn` is the user's click-toggle intent. True means the
// user is NOT manually muted. In voice-activity mode this is the entire
// signal; in PTT/PTM it's combined with `hotkeyHeld`. Transient: not
// persisted across refresh (Discord behavior — refresh unmutes).
const [userWantsMicOn, setUserWantsMicOnSignal] = createSignal(true);

// `hotkeyHeld` is true while the bound PTT/PTM combo is physically
// held down (after the release debounce in `useGlobalMicHotkey`).
const [hotkeyHeld, setHotkeyHeldSignal] = createSignal(false);

// `hotkeyCaptureActive` is true while the user is rebinding the hotkey
// in `HotkeyCaptureButton`. `useGlobalMicHotkey` short-circuits while
// this is true so rebinding presses don't transiently key the mic in
// PTT/PTM mode (both listeners are capture-phase on window, and the
// global one was registered first, so it would otherwise fire before
// the capture UI's preventDefault).
const [hotkeyCaptureActive, setHotkeyCaptureActiveSignal] = createSignal(false);

export function micHotkeyCaptureActive(): boolean {
	return hotkeyCaptureActive();
}

export function setMicHotkeyCaptureActive(value: boolean): void {
	setHotkeyCaptureActiveSignal(value);
}

/**
 * The user's click-toggle mic intent (true = unmuted by click).
 * Toggled by the UserBar mic button and the in-call mute button.
 * Transient — refresh resets to unmuted (see header comment).
 */
export function userWantsMic(): boolean {
	return userWantsMicOn();
}

export function setUserWantsMic(value: boolean): void {
	setUserWantsMicOnSignal(value);
}

export function toggleUserWantsMic(): void {
	setUserWantsMicOnSignal((v) => !v);
}

/**
 * Live hotkey-held signal. Driven by `useGlobalMicHotkey`.
 * Components should not write this directly.
 */
export function micHotkeyHeld(): boolean {
	return hotkeyHeld();
}

export function setMicHotkeyHeld(value: boolean): void {
	setHotkeyHeldSignal(value);
}

/**
 * Derived: should the mic actually be transmitting right now?
 *
 * Combines `userWantsMicOn`, `hotkeyHeld`, and `userSettings().micMode`.
 * When the mode is PTT or PTM but no hotkey is bound, we fall back to
 * voice-activity semantics (transmit whenever the user wants mic on)
 * to avoid a "permanently muted forever" footgun — the UI surfaces a
 * hint prompting the user to bind a key.
 */
export const micEnabled: Accessor<boolean> = createMemo(() => {
	if (!userWantsMicOn()) return false;
	const settings = userSettings();
	const mode = settings.micMode;
	const hasBinding = settings.micHotkey !== null;
	if (mode === "push-to-talk") {
		if (!hasBinding) return true; // unbound PTT → fall back to always-on
		return hotkeyHeld();
	}
	if (mode === "push-to-mute") {
		if (!hasBinding) return true; // unbound PTM → fall back to always-on
		return !hotkeyHeld();
	}
	return true;
});

/**
 * Test-only: reset all transient voice state. Call in `beforeEach` /
 * `afterEach`. Does NOT touch `userSettings()` (the test owns those
 * directly via `updateSetting`).
 */
export function _resetVoiceForTests(): void {
	setUserWantsMicOnSignal(true);
	setHotkeyHeldSignal(false);
	setHotkeyCaptureActiveSignal(false);
}
