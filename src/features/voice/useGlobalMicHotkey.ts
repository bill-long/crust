import { createEffect, on, onCleanup } from "solid-js";
import { isNativeShell } from "../../app/nativeShell";
import { type MicHotkey, userSettings } from "../../stores/settings";
import { micHotkeyCaptureActive, setMicHotkeyHeld } from "../../stores/voice";
import { isTypingTarget } from "./typingTarget";

/**
 * Global push-to-talk / push-to-mute hotkey listener (Phase 6 of #122
 * — issue #108). Mount once at the app root.
 *
 * BROWSER-ONLY: in the desktop shell a separate OS-level keyboard-hook
 * sidecar (`useNativeMicHotkey`) is the single authoritative input path in
 * every focus state, so this DOM listener short-circuits there to avoid a
 * second writer of the held state. In a plain browser it is the sole path.
 *
 * - No listeners attached when `micMode` is `"voice-activity"` or
 *   `micHotkey` is unbound — zero overhead in the default case.
 * - Tracks the set of currently-pressed `KeyboardEvent.code`s and
 *   recomputes "is the bound combo held?" on every key event. This
 *   correctly handles releases where the browser drops modifier flags
 *   on keyup (e.g. releasing Ctrl reports `ctrlKey=false`), and also
 *   covers users releasing modifier before primary key in combos.
 * - Suppresses while focus is in an `<input>`, `<textarea>`,
 *   `<select>`, or any contenteditable ancestor — so typing in the
 *   composer never hijacks the mic.
 * - Debounces the held→released transition by 30 ms so a brief keyup
 *   blip from auto-repeat or modifier-order quirks doesn't cut audio.
 * - Clears `hotkeyHeld` immediately on `window blur` to avoid a
 *   stuck-on hotkey when the user alt-tabs while holding a key.
 *
 * NB: we don't `preventDefault` — picking `Ctrl+T` will still open a
 * new tab. Users are expected to choose a non-conflicting combo.
 */

const MODIFIER_CODES_FOR: Record<
	keyof Omit<MicHotkey, "code">,
	[string, string]
> = {
	ctrl: ["ControlLeft", "ControlRight"],
	shift: ["ShiftLeft", "ShiftRight"],
	alt: ["AltLeft", "AltRight"],
	meta: ["MetaLeft", "MetaRight"],
};

const RELEASE_DEBOUNCE_MS = 30;

function comboIsHeld(combo: MicHotkey, pressed: ReadonlySet<string>): boolean {
	if (combo.ctrl && !MODIFIER_CODES_FOR.ctrl.some((c) => pressed.has(c)))
		return false;
	if (combo.shift && !MODIFIER_CODES_FOR.shift.some((c) => pressed.has(c)))
		return false;
	if (combo.alt && !MODIFIER_CODES_FOR.alt.some((c) => pressed.has(c)))
		return false;
	if (combo.meta && !MODIFIER_CODES_FOR.meta.some((c) => pressed.has(c)))
		return false;
	if (combo.code === null) {
		// Modifier-only combo requires at least one stored modifier.
		return combo.ctrl || combo.shift || combo.alt || combo.meta;
	}
	return pressed.has(combo.code);
}

export function useGlobalMicHotkey(): void {
	// Desktop shell uses the OS-hook sidecar (`useNativeMicHotkey`) as the sole
	// held-state writer; don't attach the DOM listener there.
	if (isNativeShell()) return;
	createEffect(
		on(
			() => {
				const s = userSettings();
				return { mode: s.micMode, hotkey: s.micHotkey };
			},
			({ mode, hotkey }) => {
				// Always clear pressed state when the binding changes — a
				// dangling true would leak across rebinding.
				setMicHotkeyHeld(false);
				if (mode === "voice-activity" || hotkey === null) return;

				const pressed = new Set<string>();
				let releaseTimer: ReturnType<typeof setTimeout> | null = null;
				let lastHeld = false;

				const applyHeld = (held: boolean): void => {
					if (held === lastHeld && releaseTimer === null) return;
					if (held) {
						if (releaseTimer !== null) {
							clearTimeout(releaseTimer);
							releaseTimer = null;
						}
						if (!lastHeld) {
							lastHeld = true;
							setMicHotkeyHeld(true);
						}
						return;
					}
					if (releaseTimer !== null) clearTimeout(releaseTimer);
					releaseTimer = setTimeout(() => {
						releaseTimer = null;
						lastHeld = false;
						setMicHotkeyHeld(false);
					}, RELEASE_DEBOUNCE_MS);
				};

				const forceClearHeld = (): void => {
					pressed.clear();
					if (releaseTimer !== null) {
						clearTimeout(releaseTimer);
						releaseTimer = null;
					}
					if (lastHeld) {
						lastHeld = false;
						setMicHotkeyHeld(false);
					}
				};

				const onKeyDown = (e: KeyboardEvent): void => {
					if (micHotkeyCaptureActive()) return;
					if (isTypingTarget(e.target)) return;
					if (e.repeat) return;
					pressed.add(e.code);
					applyHeld(comboIsHeld(hotkey, pressed));
				};

				const onKeyUp = (e: KeyboardEvent): void => {
					if (micHotkeyCaptureActive()) {
						// Capture is rebinding — drop any held state immediately
						// (bypass the release debounce) so a key held when capture
						// started can't keep transmitting during rebinding.
						forceClearHeld();
						return;
					}
					pressed.delete(e.code);
					applyHeld(comboIsHeld(hotkey, pressed));
				};

				// Clear held when the window loses focus so a key held during
				// alt-tab doesn't keep the mic keyed.
				const onBlur = (): void => {
					forceClearHeld();
				};

				window.addEventListener("keydown", onKeyDown, { capture: true });
				window.addEventListener("keyup", onKeyUp, { capture: true });
				const onFocusIn = (e: FocusEvent): void => {
					// If focus moves into a typing target (input/textarea/select/
					// contenteditable) while the hotkey is still held, no keydown
					// fires there to trigger suppression. Force-clear held state
					// so the mic doesn't stay keyed while the user types.
					if (isTypingTarget(e.target)) forceClearHeld();
				};

				window.addEventListener("blur", onBlur);
				window.addEventListener("focusin", onFocusIn);

				// When the user starts rebinding the hotkey, immediately drop
				// any in-flight held state so a key held at capture-start can't
				// keep keying the mic while the rebinding UI absorbs presses.
				createEffect(() => {
					if (micHotkeyCaptureActive()) forceClearHeld();
				});

				onCleanup(() => {
					window.removeEventListener("keydown", onKeyDown, { capture: true });
					window.removeEventListener("keyup", onKeyUp, { capture: true });
					window.removeEventListener("blur", onBlur);
					window.removeEventListener("focusin", onFocusIn);
					if (releaseTimer !== null) {
						clearTimeout(releaseTimer);
						releaseTimer = null;
					}
				});
			},
		),
	);
}
