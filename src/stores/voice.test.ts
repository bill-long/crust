import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MicHotkey, updateSetting, userSettings } from "./settings";
import {
	_resetVoiceForTests,
	micEnabled,
	micHotkeyHeld,
	setMicHotkeyHeld,
	setUserWantsMic,
	toggleUserWantsMic,
	userWantsMic,
} from "./voice";

const SOME_HOTKEY: MicHotkey = {
	ctrl: true,
	shift: false,
	alt: false,
	meta: false,
	code: "Space",
};

describe("voice store", () => {
	let prevMode: "voice-activity" | "push-to-talk" | "push-to-mute";
	let prevHotkey: MicHotkey | null;

	beforeEach(() => {
		const s = userSettings();
		prevMode = s.micMode;
		prevHotkey = s.micHotkey;
		_resetVoiceForTests();
	});

	afterEach(() => {
		_resetVoiceForTests();
		updateSetting("micMode", prevMode);
		updateSetting("micHotkey", prevHotkey);
	});

	it("defaults to mic enabled in voice-activity mode", () => {
		updateSetting("micMode", "voice-activity");
		updateSetting("micHotkey", null);
		createRoot(() => {
			expect(userWantsMic()).toBe(true);
			expect(micHotkeyHeld()).toBe(false);
			expect(micEnabled()).toBe(true);
		});
	});

	it("toggleUserWantsMic flips intent and feeds through micEnabled", () => {
		updateSetting("micMode", "voice-activity");
		createRoot(() => {
			toggleUserWantsMic();
			expect(userWantsMic()).toBe(false);
			expect(micEnabled()).toBe(false);
			toggleUserWantsMic();
			expect(micEnabled()).toBe(true);
		});
	});

	it("PTT mode is muted by default; held flips on", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", SOME_HOTKEY);
		createRoot(() => {
			expect(micEnabled()).toBe(false); // not held
			setMicHotkeyHeld(true);
			expect(micEnabled()).toBe(true);
			setMicHotkeyHeld(false);
			expect(micEnabled()).toBe(false);
		});
	});

	it("PTM mode is unmuted by default; held flips off", () => {
		updateSetting("micMode", "push-to-mute");
		updateSetting("micHotkey", SOME_HOTKEY);
		createRoot(() => {
			expect(micEnabled()).toBe(true);
			setMicHotkeyHeld(true);
			expect(micEnabled()).toBe(false);
			setMicHotkeyHeld(false);
			expect(micEnabled()).toBe(true);
		});
	});

	it("PTT/PTM with unbound hotkey falls back to always-on (anti-footgun)", () => {
		updateSetting("micHotkey", null);
		createRoot(() => {
			updateSetting("micMode", "push-to-talk");
			expect(micEnabled()).toBe(true);
			updateSetting("micMode", "push-to-mute");
			expect(micEnabled()).toBe(true);
		});
	});

	it("userWantsMic=false hard-mutes regardless of mode", () => {
		updateSetting("micMode", "push-to-talk");
		updateSetting("micHotkey", SOME_HOTKEY);
		createRoot(() => {
			setUserWantsMic(false);
			setMicHotkeyHeld(true);
			expect(micEnabled()).toBe(false);
		});
	});
});
