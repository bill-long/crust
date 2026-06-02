import {
	type Component,
	createEffect,
	createSignal,
	on,
	onCleanup,
	Show,
} from "solid-js";
import {
	type MicHotkey,
	updateSetting,
	userSettings,
} from "../../stores/settings";
import { setMicHotkeyCaptureActive } from "../../stores/voice";

/**
 * Capture + display + clear UI for `userSettings().micHotkey`.
 *
 * Capture flow:
 * - Click "Click to bind" → enter capture mode (one-shot window listener).
 * - Press a non-modifier key with optional modifiers → save combo, exit.
 * - Press only modifier(s) then release all of them → save modifier-only
 *   combo (peak modifier set). Lets the user bind e.g. just Ctrl.
 * - Esc with no modifiers held → cancel capture.
 *
 * Renders a button labeled with the current binding (or "Click to bind")
 * plus an unbind (×) button when a binding exists.
 */

const MODIFIER_CODES = new Set<string>([
	"ControlLeft",
	"ControlRight",
	"ShiftLeft",
	"ShiftRight",
	"AltLeft",
	"AltRight",
	"MetaLeft",
	"MetaRight",
]);

function formatHotkey(h: MicHotkey | null): string {
	if (h === null) return "Click to bind";
	const parts: string[] = [];
	if (h.ctrl) parts.push("Ctrl");
	if (h.shift) parts.push("Shift");
	if (h.alt) parts.push("Alt");
	if (h.meta) parts.push("Meta");
	if (h.code !== null) parts.push(formatCode(h.code));
	return parts.length > 0 ? parts.join("+") : "Click to bind";
}

function formatCode(code: string): string {
	if (code.startsWith("Key")) return code.slice(3); // KeyT → T
	if (code.startsWith("Digit")) return code.slice(5); // Digit1 → 1
	if (code.startsWith("Arrow")) return code; // ArrowLeft → ArrowLeft (clearer than just Left)
	return code;
}

export const HotkeyCaptureButton: Component = () => {
	const [capturing, setCapturing] = createSignal(false);
	// Pending committed combo (or `null` to clear). Written by the capture
	// session's keydown/keyup handlers; consumed by the capture effect to
	// commit the new binding and exit capture in a reactive scope.
	const [pendingCommit, setPendingCommit] = createSignal<{
		value: MicHotkey | null;
	} | null>(null);

	// Capture lifecycle lives in a reactive effect so its `onCleanup` is
	// bound to the component owner. Click handlers run with no owner, so an
	// `onCleanup` registered inside `startCapture` would silently no-op and
	// the window listeners would leak across an unmount-during-capture.
	createEffect(
		on(capturing, (active) => {
			if (!active) return;
			setMicHotkeyCaptureActive(true);
			const pressedMods = new Set<string>();
			const peak = { ctrl: false, shift: false, alt: false, meta: false };
			let done = false;

			const finish = (combo: MicHotkey | null): void => {
				if (done) return;
				done = true;
				setPendingCommit({ value: combo });
				setCapturing(false);
			};

			const onDown = (e: KeyboardEvent): void => {
				e.preventDefault();
				e.stopPropagation();
				if (
					e.code === "Escape" &&
					!e.ctrlKey &&
					!e.shiftKey &&
					!e.altKey &&
					!e.metaKey
				) {
					finish(null);
					return;
				}
				if (MODIFIER_CODES.has(e.code)) {
					pressedMods.add(e.code);
					if (e.ctrlKey) peak.ctrl = true;
					if (e.shiftKey) peak.shift = true;
					if (e.altKey) peak.alt = true;
					if (e.metaKey) peak.meta = true;
					return;
				}
				finish({
					ctrl: e.ctrlKey,
					shift: e.shiftKey,
					alt: e.altKey,
					meta: e.metaKey,
					code: e.code,
				});
			};

			const onUp = (e: KeyboardEvent): void => {
				if (!MODIFIER_CODES.has(e.code)) return;
				pressedMods.delete(e.code);
				if (pressedMods.size === 0) {
					if (peak.ctrl || peak.shift || peak.alt || peak.meta) {
						finish({ ...peak, code: null });
					} else {
						finish(null);
					}
				}
			};

			const onBlur = (): void => finish(null);

			window.addEventListener("keydown", onDown, { capture: true });
			window.addEventListener("keyup", onUp, { capture: true });
			window.addEventListener("blur", onBlur);

			onCleanup(() => {
				done = true;
				window.removeEventListener("keydown", onDown, { capture: true });
				window.removeEventListener("keyup", onUp, { capture: true });
				window.removeEventListener("blur", onBlur);
				setMicHotkeyCaptureActive(false);
			});
		}),
	);

	// Apply pending commits OUTSIDE the capture effect so writing to settings
	// doesn't re-enter the capture lifecycle's `on(capturing,...)` tracking.
	createEffect(() => {
		const pending = pendingCommit();
		if (!pending) return;
		if (pending.value !== null) updateSetting("micHotkey", pending.value);
		setPendingCommit(null);
	});

	const startCapture = (): void => {
		if (capturing()) return;
		setCapturing(true);
	};

	const clearBinding = (): void => {
		updateSetting("micHotkey", null);
	};

	return (
		<div class="flex items-center gap-1">
			<button
				type="button"
				onClick={startCapture}
				disabled={capturing()}
				class="flex-1 rounded bg-surface-2 px-2 py-1 text-left text-xs text-text-primary transition-colors hover:bg-surface-1 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover any-pointer-coarse:min-h-11 any-pointer-coarse:py-3 any-pointer-coarse:text-sm"
				aria-label={
					capturing()
						? "Press a key combination, or press Escape to cancel"
						: `Mic hotkey: ${formatHotkey(userSettings().micHotkey)}. Click to rebind.`
				}
			>
				<Show
					when={capturing()}
					fallback={formatHotkey(userSettings().micHotkey)}
				>
					<span aria-live="polite">Press a key…</span>
				</Show>
			</button>
			<Show when={userSettings().micHotkey !== null && !capturing()}>
				<button
					type="button"
					onClick={clearBinding}
					class="flex h-6 w-6 items-center justify-center rounded text-text-muted transition-colors hover:bg-surface-1 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover any-pointer-coarse:h-11 any-pointer-coarse:w-11"
					aria-label="Clear mic hotkey binding"
					title="Clear binding"
				>
					×
				</button>
			</Show>
		</div>
	);
};
