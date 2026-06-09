import { createEffect, on, onCleanup, onMount } from "solid-js";
import { isNativeShell } from "../../app/nativeShell";
import { invokeTauri, listenTauri } from "../../app/tauri";
import { type MicHotkey, userSettings } from "../../stores/settings";
import { micHotkeyCaptureActive, setMicHotkeyHeld } from "../../stores/voice";
import { isTypingTarget } from "./typingTarget";

/**
 * Desktop-shell push-to-talk / push-to-mute driver. A low-level OS keyboard
 * hook runs in a separate sidecar PROCESS (in Rust) and watches the bound combo
 * regardless of which window is focused — including while a game is focused,
 * which an in-window DOM listener can't see. It emits a `mic-hotkey` event
 * (payload = held: boolean) on every transition (plus a snapshot after each
 * (re)bind); this hook mirrors that into the shared voice store.
 *
 * It REPLACES `useGlobalMicHotkey` in the native shell (that DOM listener
 * short-circuits there), so this is the SINGLE authoritative writer of the held
 * state in every focus state — no fragile focus hand-off between two paths.
 *
 * Held events are applied unconditionally EXCEPT:
 *  - while the user is rebinding the hotkey (`micHotkeyCaptureActive`), held is
 *    forced false so the old combo can't key the mic mid-rebind; and
 *  - a `held=true` is ignored while Crust is focused AND a text field has focus,
 *    so a plain-key bind (e.g. push-to-mute on "M") doesn't toggle the mic while
 *    the user types in the composer. A `held=false` (release) is always applied,
 *    so this suppression can never leave the mic stuck.
 *
 * Responsibilities:
 *  - Mirror the user's combo to Rust whenever `micMode`/`micHotkey` change
 *    (sending `null` in voice-activity mode or when unbound, which clears it).
 *  - Translate the `mic-hotkey` held events into `setMicHotkeyHeld`.
 *
 * Mount once at the app root, alongside `useGlobalMicHotkey`.
 */
export function useNativeMicHotkey(): void {
	if (!isNativeShell()) return;

	onMount(() => {
		let unlisten: (() => void) | null = null;
		let disposed = false;
		void listenTauri<boolean>("mic-hotkey", (held) => {
			// Rebinding: never let the (old) combo key the mic.
			if (micHotkeyCaptureActive()) {
				setMicHotkeyHeld(false);
				return;
			}
			// Don't let a press toggle the mic while the user is typing in
			// Crust. Only a press is suppressed; a release always applies so
			// the mic can't get stuck on. (Game-focused: hasFocus() is false,
			// so the sidecar drives mute normally.)
			if (
				held === true &&
				document.hasFocus() &&
				isTypingTarget(document.activeElement)
			) {
				return;
			}
			setMicHotkeyHeld(held === true);
		}).then((u) => {
			// The hook may have been cleaned up while the listener was being
			// registered; unsubscribe immediately if so.
			if (disposed) u();
			else unlisten = u;
		});

		// If focus moves INTO a Crust text field while the key is still held
		// (e.g. held while a game was focused, then the user clicks the
		// composer), no key event fires, so the press-suppression above can't
		// run. Force-clear here so the mic doesn't stay keyed while typing —
		// mirrors the browser DOM hook's focusin guard.
		const onFocusIn = (e: FocusEvent): void => {
			if (isTypingTarget(e.target)) setMicHotkeyHeld(false);
		};
		window.addEventListener("focusin", onFocusIn);

		onCleanup(() => {
			disposed = true;
			unlisten?.();
			window.removeEventListener("focusin", onFocusIn);
			setMicHotkeyHeld(false);
			// Clear the watched combo so the sidecar stops reporting once this
			// surface unmounts.
			void invokeTauri("set_mic_hotkey", { hotkey: null });
		});
	});

	createEffect(
		on(
			() => {
				const s = userSettings();
				return { mode: s.micMode, hotkey: s.micHotkey };
			},
			({ mode, hotkey }) => {
				const combo: MicHotkey | null =
					mode === "voice-activity" || hotkey === null ? null : hotkey;
				void invokeTauri("set_mic_hotkey", { hotkey: combo });
				// When cleared, drop any held state immediately (Rust also emits
				// held=false, but don't wait for the round-trip).
				if (combo === null) setMicHotkeyHeld(false);
			},
		),
	);

	// When the user starts rebinding the hotkey, immediately drop any in-flight
	// held state so a key held at capture-start can't keep keying the mic while
	// the rebinding UI absorbs presses. The event handler above also ignores
	// events during capture, but a key already held emits no new event, so this
	// effect clears it synchronously.
	createEffect(() => {
		if (micHotkeyCaptureActive()) setMicHotkeyHeld(false);
	});
}
