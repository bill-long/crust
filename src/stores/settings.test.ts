import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSession, type Session, saveSession } from "./session";
import {
	type MicHotkey,
	parseMicHotkey,
	updateSetting,
	userSettings,
} from "./settings";

describe("parseMicHotkey", () => {
	it("returns null for null/undefined/non-object input", () => {
		expect(parseMicHotkey(null)).toBeNull();
		expect(parseMicHotkey(undefined)).toBeNull();
		expect(parseMicHotkey("nope")).toBeNull();
		expect(parseMicHotkey(42)).toBeNull();
		expect(parseMicHotkey(true)).toBeNull();
	});

	it("returns null when modifier flags are missing or wrong-typed", () => {
		expect(
			parseMicHotkey({
				ctrl: 1,
				shift: false,
				alt: false,
				meta: false,
				code: "Space",
			}),
		).toBeNull();
		expect(
			parseMicHotkey({ ctrl: false, shift: false, alt: false, code: "Space" }),
		).toBeNull();
	});

	it("returns null when code is not string|null", () => {
		expect(
			parseMicHotkey({
				ctrl: true,
				shift: false,
				alt: false,
				meta: false,
				code: 5,
			}),
		).toBeNull();
	});

	it("rejects the empty binding (no modifiers, no code)", () => {
		expect(
			parseMicHotkey({
				ctrl: false,
				shift: false,
				alt: false,
				meta: false,
				code: null,
			}),
		).toBeNull();
		// Empty-string code is also degenerate and must be treated as unbound.
		expect(
			parseMicHotkey({
				ctrl: false,
				shift: false,
				alt: false,
				meta: false,
				code: "",
			}),
		).toBeNull();
	});

	it("accepts modifier-only combos", () => {
		const h = parseMicHotkey({
			ctrl: true,
			shift: false,
			alt: false,
			meta: false,
			code: null,
		});
		expect(h).toEqual<MicHotkey>({
			ctrl: true,
			shift: false,
			alt: false,
			meta: false,
			code: null,
		});
	});

	it("accepts modifier + key combos and normalizes empty-string code to null", () => {
		expect(
			parseMicHotkey({
				ctrl: true,
				shift: true,
				alt: false,
				meta: false,
				code: "Space",
			}),
		).toEqual<MicHotkey>({
			ctrl: true,
			shift: true,
			alt: false,
			meta: false,
			code: "Space",
		});
		// Modifier present + empty code → empty code normalizes to null,
		// binding still accepted as modifier-only.
		expect(
			parseMicHotkey({
				ctrl: true,
				shift: false,
				alt: false,
				meta: false,
				code: "",
			}),
		).toEqual<MicHotkey>({
			ctrl: true,
			shift: false,
			alt: false,
			meta: false,
			code: null,
		});
	});

	it("accepts code-only combos (no modifiers)", () => {
		expect(
			parseMicHotkey({
				ctrl: false,
				shift: false,
				alt: false,
				meta: false,
				code: "F13",
			}),
		).toEqual<MicHotkey>({
			ctrl: false,
			shift: false,
			alt: false,
			meta: false,
			code: "F13",
		});
	});
});

describe("account scoping", () => {
	const SETTINGS_KEY = "crust:settings";
	const ALICE: Session = {
		accessToken: "syt_a",
		userId: "@alice:example.com",
		deviceId: "DEV_A",
		homeserverUrl: "https://matrix.example.com",
	};
	const BOB: Session = {
		...ALICE,
		accessToken: "syt_b",
		userId: "@bob:example.com",
		deviceId: "DEV_B",
	};

	beforeEach(() => {
		localStorage.clear();
		saveSession(ALICE);
	});
	afterEach(() => {
		clearSession(ALICE.userId);
		localStorage.clear();
	});

	it("persists under the active account's key", () => {
		updateSetting("timeFormat", "24h");
		expect(
			localStorage.getItem(`${SETTINGS_KEY}:${ALICE.userId}`),
		).not.toBeNull();
		expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
	});

	it("rebinds to the new account's settings on a switch", () => {
		updateSetting("timeFormat", "24h");
		updateSetting("zoomLevel", 150);
		saveSession(BOB);
		// Bob has never set anything: he gets the defaults, not Alice's choices.
		expect(userSettings().timeFormat).toBe("12h");
		expect(userSettings().zoomLevel).toBe(100);
		updateSetting("timeFormat", "24h");
		saveSession(ALICE);
		expect(userSettings().zoomLevel).toBe(150);
	});

	it("keeps changes out of storage while logged out", () => {
		clearSession(ALICE.userId);
		updateSetting("timeFormat", "24h");
		expect(userSettings().timeFormat).toBe("24h");
		expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
	});
});
