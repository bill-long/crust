import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type MicHotkey,
	updateSetting,
	userSettings,
} from "../../stores/settings";
import {
	_resetVoiceForTests,
	micHotkeyHeld,
	setMicHotkeyCaptureActive,
} from "../../stores/voice";
import { useNativeMicHotkey } from "./useNativeMicHotkey";

const HOTKEY_ALT: MicHotkey = {
	ctrl: false,
	shift: false,
	alt: true,
	meta: false,
	code: null,
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("useNativeMicHotkey", () => {
	let prevMode: "voice-activity" | "push-to-talk" | "push-to-mute";
	let prevHotkey: MicHotkey | null;
	let disposers: Array<() => void> = [];
	let invoke: ReturnType<typeof vi.fn>;
	let eventHandler: ((raw: unknown) => void) | null;

	beforeEach(() => {
		const s = userSettings();
		prevMode = s.micMode;
		prevHotkey = s.micHotkey;
		_resetVoiceForTests();
		eventHandler = null;
		// `plugin:event|listen` returns a numeric event id; everything else
		// (set_mic_hotkey, unlisten) resolves undefined.
		invoke = vi.fn().mockImplementation((cmd: string) => {
			if (cmd === "plugin:event|listen") return Promise.resolve(1);
			return Promise.resolve(undefined);
		});
		const transformCallback = vi
			.fn()
			.mockImplementation((cb: (raw: unknown) => void) => {
				eventHandler = cb;
				return 1;
			});
		(window as { isTauri?: boolean }).isTauri = true;
		(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
			invoke,
			transformCallback,
		};
	});

	afterEach(() => {
		for (const d of disposers) d();
		disposers = [];
		(window as { isTauri?: boolean }).isTauri = undefined;
		(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ =
			undefined;
		_resetVoiceForTests();
		updateSetting("micMode", prevMode);
		updateSetting("micHotkey", prevHotkey);
	});

	function mount(): void {
		createRoot((dispose) => {
			useNativeMicHotkey();
			disposers.push(dispose);
		});
	}

	it("does nothing outside the native shell", () => {
		(window as { isTauri?: boolean }).isTauri = undefined;
		updateSetting("micMode", "push-to-mute");
		updateSetting("micHotkey", HOTKEY_ALT);
		mount();
		expect(invoke).not.toHaveBeenCalled();
	});

	it("mirrors the bound combo to Rust on mount", () => {
		updateSetting("micMode", "push-to-mute");
		updateSetting("micHotkey", HOTKEY_ALT);
		mount();
		expect(invoke).toHaveBeenCalledWith("set_mic_hotkey", {
			hotkey: HOTKEY_ALT,
		});
	});

	it("sends null in voice-activity mode", () => {
		updateSetting("micMode", "voice-activity");
		updateSetting("micHotkey", HOTKEY_ALT);
		mount();
		expect(invoke).toHaveBeenCalledWith("set_mic_hotkey", { hotkey: null });
	});

	it("drives the held state from mic-hotkey events regardless of focus", async () => {
		// Crust focused, but focus is not on a text field → events apply.
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
		updateSetting("micMode", "push-to-mute");
		updateSetting("micHotkey", HOTKEY_ALT);
		mount();
		await flush();
		expect(eventHandler).not.toBeNull();

		eventHandler?.({ payload: true });
		expect(micHotkeyHeld()).toBe(true);
		eventHandler?.({ payload: false });
		expect(micHotkeyHeld()).toBe(false);
		hasFocus.mockRestore();
	});

	it("suppresses a press while typing in a focused Crust text field", async () => {
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();
		updateSetting("micMode", "push-to-mute");
		updateSetting("micHotkey", HOTKEY_ALT);
		mount();
		await flush();

		// Press while typing must NOT key the mic.
		eventHandler?.({ payload: true });
		expect(micHotkeyHeld()).toBe(false);
		input.remove();
		hasFocus.mockRestore();
	});

	it("applies a release even while typing, so the mic can't stick", async () => {
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
		updateSetting("micMode", "push-to-mute");
		updateSetting("micHotkey", HOTKEY_ALT);
		mount();
		await flush();

		// Hold the key while focus is on the body (not a text field) → keyed.
		eventHandler?.({ payload: true });
		expect(micHotkeyHeld()).toBe(true);

		// Now focus moves into a text field and the key is released. Even though
		// a press would be suppressed here, the release must apply.
		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();
		eventHandler?.({ payload: false });
		expect(micHotkeyHeld()).toBe(false);
		input.remove();
		hasFocus.mockRestore();
	});

	it("forces held false while the hotkey is being rebound", async () => {
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
		updateSetting("micMode", "push-to-mute");
		updateSetting("micHotkey", HOTKEY_ALT);
		mount();
		await flush();

		setMicHotkeyCaptureActive(true);
		eventHandler?.({ payload: true });
		expect(micHotkeyHeld()).toBe(false);
		setMicHotkeyCaptureActive(false);
		hasFocus.mockRestore();
	});

	it("clears an already-held key when capture starts (no new event)", async () => {
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
		updateSetting("micMode", "push-to-mute");
		updateSetting("micHotkey", HOTKEY_ALT);
		mount();
		await flush();

		// Key is held (game-focused), then the user opens the rebind UI without
		// releasing it. No new event fires, so the capture effect must clear it.
		eventHandler?.({ payload: true });
		expect(micHotkeyHeld()).toBe(true);
		setMicHotkeyCaptureActive(true);
		expect(micHotkeyHeld()).toBe(false);
		setMicHotkeyCaptureActive(false);
		hasFocus.mockRestore();
	});

	it("clears held when focus moves into a Crust text field mid-hold", async () => {
		const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
		updateSetting("micMode", "push-to-mute");
		updateSetting("micHotkey", HOTKEY_ALT);
		mount();
		await flush();

		// Key held while a game was focused → mic keyed.
		eventHandler?.({ payload: true });
		expect(micHotkeyHeld()).toBe(true);

		// User clicks into the composer while still holding the key. No key
		// event fires, so a focusin guard must clear held immediately.
		const input = document.createElement("input");
		document.body.appendChild(input);
		input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(micHotkeyHeld()).toBe(false);
		input.remove();
		hasFocus.mockRestore();
	});
});
