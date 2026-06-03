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
import { useGlobalMicHotkey } from "./useGlobalMicHotkey";

const HOTKEY_CTRL_SPACE: MicHotkey = {
	ctrl: true,
	shift: false,
	alt: false,
	meta: false,
	code: "Space",
};

const HOTKEY_CTRL_ONLY: MicHotkey = {
	ctrl: true,
	shift: false,
	alt: false,
	meta: false,
	code: null,
};

function fireKey(
	type: "keydown" | "keyup",
	code: string,
	modifiers: Partial<{
		ctrlKey: boolean;
		shiftKey: boolean;
		altKey: boolean;
		metaKey: boolean;
	}> = {},
	target: EventTarget = window,
): void {
	const ev = new KeyboardEvent(type, {
		code,
		ctrlKey: !!modifiers.ctrlKey,
		shiftKey: !!modifiers.shiftKey,
		altKey: !!modifiers.altKey,
		metaKey: !!modifiers.metaKey,
		bubbles: true,
		cancelable: true,
	});
	target.dispatchEvent(ev);
}

describe("useGlobalMicHotkey", () => {
	let prevMode: "voice-activity" | "push-to-talk" | "push-to-mute";
	let prevHotkey: MicHotkey | null;
	let disposers: Array<() => void> = [];

	beforeEach(() => {
		vi.useFakeTimers();
		const s = userSettings();
		prevMode = s.micMode;
		prevHotkey = s.micHotkey;
		_resetVoiceForTests();
	});

	afterEach(() => {
		for (const d of disposers) d();
		disposers = [];
		vi.useRealTimers();
		_resetVoiceForTests();
		updateSetting("micMode", prevMode);
		updateSetting("micHotkey", prevHotkey);
	});

	function mountHook(): void {
		createRoot((dispose) => {
			useGlobalMicHotkey();
			disposers.push(dispose);
		});
	}

	it("is a no-op when mode is voice-activity", () => {
		updateSetting("micMode", "voice-activity");
		updateSetting("micHotkey", HOTKEY_CTRL_SPACE);
		mountHook();
		fireKey("keydown", "ControlLeft", { ctrlKey: true });
		fireKey("keydown", "Space", { ctrlKey: true });
		expect(micHotkeyHeld()).toBe(false);
	});

	it("is a no-op when hotkey is unbound", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", null);
		mountHook();
		fireKey("keydown", "Space");
		expect(micHotkeyHeld()).toBe(false);
	});

	it("flips held on modifier+key press, releases after debounce", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", HOTKEY_CTRL_SPACE);
		mountHook();
		fireKey("keydown", "ControlLeft", { ctrlKey: true });
		expect(micHotkeyHeld()).toBe(false); // only ctrl held; need Space too
		fireKey("keydown", "Space", { ctrlKey: true });
		expect(micHotkeyHeld()).toBe(true);
		// Release Space with ctrlKey=false (browser may drop modifier flag).
		fireKey("keyup", "Space");
		expect(micHotkeyHeld()).toBe(true); // debounced
		vi.advanceTimersByTime(40);
		expect(micHotkeyHeld()).toBe(false);
	});

	it("detects modifier-only combo via modifier code", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", HOTKEY_CTRL_ONLY);
		mountHook();
		fireKey("keydown", "ControlLeft", { ctrlKey: true });
		expect(micHotkeyHeld()).toBe(true);
		fireKey("keyup", "ControlLeft");
		vi.advanceTimersByTime(40);
		expect(micHotkeyHeld()).toBe(false);
	});

	it("suppresses when focus is in an input", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", HOTKEY_CTRL_SPACE);
		mountHook();
		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();
		fireKey("keydown", "ControlLeft", { ctrlKey: true }, input);
		fireKey("keydown", "Space", { ctrlKey: true }, input);
		expect(micHotkeyHeld()).toBe(false);
		document.body.removeChild(input);
	});

	it("suppresses when focus is in a contenteditable", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", HOTKEY_CTRL_SPACE);
		mountHook();
		const div = document.createElement("div");
		div.setAttribute("contenteditable", "true");
		document.body.appendChild(div);
		fireKey("keydown", "ControlLeft", { ctrlKey: true }, div);
		fireKey("keydown", "Space", { ctrlKey: true }, div);
		expect(micHotkeyHeld()).toBe(false);
		document.body.removeChild(div);
	});

	it("suppresses when focus is in a contenteditable=plaintext-only", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", HOTKEY_CTRL_SPACE);
		mountHook();
		const div = document.createElement("div");
		div.setAttribute("contenteditable", "plaintext-only");
		document.body.appendChild(div);
		fireKey("keydown", "ControlLeft", { ctrlKey: true }, div);
		fireKey("keydown", "Space", { ctrlKey: true }, div);
		expect(micHotkeyHeld()).toBe(false);
		document.body.removeChild(div);
	});

	it("suppresses when target is inside a contenteditable=false widget nested in an editable host", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", HOTKEY_CTRL_SPACE);
		mountHook();
		// Rich-editor pattern: editable host with a read-only inline widget
		// (e.g. a mention chip). Keydowns originating inside the false widget
		// must still suppress because the user is editing the surrounding host.
		const host = document.createElement("div");
		host.setAttribute("contenteditable", "true");
		const widget = document.createElement("span");
		widget.setAttribute("contenteditable", "false");
		host.appendChild(widget);
		document.body.appendChild(host);
		fireKey("keydown", "ControlLeft", { ctrlKey: true }, widget);
		fireKey("keydown", "Space", { ctrlKey: true }, widget);
		expect(micHotkeyHeld()).toBe(false);
		document.body.removeChild(host);
	});

	it("suppresses when target is inside a contenteditable=inherit nested in an editable host", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", HOTKEY_CTRL_SPACE);
		mountHook();
		// `contenteditable="inherit"` means "use the parent's editability".
		// The selector list intentionally only matches the three editable
		// values, so `closest()` walks past `inherit` to find the editable
		// host above it.
		const host = document.createElement("div");
		host.setAttribute("contenteditable", "true");
		const inner = document.createElement("span");
		inner.setAttribute("contenteditable", "inherit");
		host.appendChild(inner);
		document.body.appendChild(host);
		fireKey("keydown", "ControlLeft", { ctrlKey: true }, inner);
		fireKey("keydown", "Space", { ctrlKey: true }, inner);
		expect(micHotkeyHeld()).toBe(false);
		document.body.removeChild(host);
	});

	it("force-clears held state when focus moves into a typing target while held", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", HOTKEY_CTRL_ONLY);
		mountHook();
		// User holds the hotkey while focus is on body — gets keyed in.
		fireKey("keydown", "ControlLeft", { ctrlKey: true });
		expect(micHotkeyHeld()).toBe(true);
		// User clicks into the composer (input) while still holding Ctrl.
		// No keydown fires there; the focusin handler must drop the held state.
		const input = document.createElement("input");
		document.body.appendChild(input);
		const ev = new FocusEvent("focusin", { bubbles: true });
		input.dispatchEvent(ev);
		expect(micHotkeyHeld()).toBe(false);
		document.body.removeChild(input);
	});

	it("blur clears held state immediately (no debounce)", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", HOTKEY_CTRL_SPACE);
		mountHook();
		fireKey("keydown", "ControlLeft", { ctrlKey: true });
		fireKey("keydown", "Space", { ctrlKey: true });
		expect(micHotkeyHeld()).toBe(true);
		window.dispatchEvent(new Event("blur"));
		expect(micHotkeyHeld()).toBe(false);
	});

	it("ignores repeated keydown events", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", HOTKEY_CTRL_ONLY);
		mountHook();
		fireKey("keydown", "ControlLeft", { ctrlKey: true });
		expect(micHotkeyHeld()).toBe(true);
		// Repeat shouldn't disturb anything.
		const ev = new KeyboardEvent("keydown", {
			code: "ControlLeft",
			ctrlKey: true,
			repeat: true,
		});
		window.dispatchEvent(ev);
		expect(micHotkeyHeld()).toBe(true);
	});

	it("suppresses press handling while hotkey capture is active", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", HOTKEY_CTRL_ONLY);
		mountHook();
		setMicHotkeyCaptureActive(true);
		fireKey("keydown", "ControlLeft", { ctrlKey: true });
		expect(micHotkeyHeld()).toBe(false);
		fireKey("keyup", "ControlLeft");
		expect(micHotkeyHeld()).toBe(false);
		setMicHotkeyCaptureActive(false);
		fireKey("keydown", "ControlLeft", { ctrlKey: true });
		expect(micHotkeyHeld()).toBe(true);
	});

	it("immediately drops held state when capture starts (no debounce window)", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", HOTKEY_CTRL_ONLY);
		mountHook();
		fireKey("keydown", "ControlLeft", { ctrlKey: true });
		expect(micHotkeyHeld()).toBe(true);
		// User opens the rebind UI while the hotkey is still held.
		setMicHotkeyCaptureActive(true);
		// Held state must clear synchronously — no 30ms debounced transmit window.
		expect(micHotkeyHeld()).toBe(false);
	});
});
