import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearSession,
	loadSession,
	type Session,
	saveSession,
} from "./session";

// The persisted key is module-private; the tests that poke localStorage
// directly reference it by its literal value.
const SESSION_KEY = "crust:session";
const LEGACY_SESSION_KEY = "crust_session";

const VALID: Session = {
	accessToken: "syt_accesstoken",
	userId: "@alice:example.com",
	deviceId: "DEVICE123",
	homeserverUrl: "https://matrix.example.com",
};

beforeEach(() => localStorage.clear());
afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
});

describe("saveSession / loadSession round-trip", () => {
	it("persists a valid session and loads it back", () => {
		saveSession(VALID);
		expect(loadSession()).toEqual(VALID);
	});

	it("preserves extra unknown fields on the stored object", () => {
		// isSession only requires the known fields, so a forward-compatible
		// extra field survives the round-trip.
		const withExtra = { ...VALID, futureField: "x" };
		localStorage.setItem(SESSION_KEY, JSON.stringify(withExtra));
		expect(loadSession()).toEqual(withExtra);
	});
});

describe("loadSession", () => {
	it("returns null when nothing is stored", () => {
		expect(loadSession()).toBeNull();
	});

	it("returns null for non-JSON contents", () => {
		localStorage.setItem(SESSION_KEY, "not json {");
		expect(loadSession()).toBeNull();
	});

	it("returns null for JSON that is not an object", () => {
		localStorage.setItem(SESSION_KEY, JSON.stringify("a string"));
		expect(loadSession()).toBeNull();
		localStorage.setItem(SESSION_KEY, JSON.stringify(42));
		expect(loadSession()).toBeNull();
		localStorage.setItem(SESSION_KEY, JSON.stringify(null));
		expect(loadSession()).toBeNull();
	});

	it("returns null for an array payload", () => {
		// typeof [] === "object", so an array slips past the isRecord guard and
		// must be rejected by the per-field checks instead.
		localStorage.setItem(SESSION_KEY, JSON.stringify([]));
		expect(loadSession()).toBeNull();
		localStorage.setItem(SESSION_KEY, JSON.stringify([VALID]));
		expect(loadSession()).toBeNull();
	});

	it("returns null when a required field is missing or empty", () => {
		for (const field of [
			"accessToken",
			"userId",
			"deviceId",
			"homeserverUrl",
		] as const) {
			const missing = { ...VALID };
			delete (missing as Record<string, unknown>)[field];
			localStorage.setItem(SESSION_KEY, JSON.stringify(missing));
			expect(loadSession()).toBeNull();

			localStorage.setItem(
				SESSION_KEY,
				JSON.stringify({ ...VALID, [field]: "" }),
			);
			expect(loadSession()).toBeNull();
		}
	});

	it("returns null when a required field is present but not a string", () => {
		// Guards the typeof checks: a truthiness-only validation would wrongly
		// accept these non-string values.
		for (const [field, value] of [
			["accessToken", 123],
			["userId", true],
			["deviceId", { nested: "x" }],
			["homeserverUrl", ["https://matrix.example.com"]],
		] as const) {
			localStorage.setItem(
				SESSION_KEY,
				JSON.stringify({ ...VALID, [field]: value }),
			);
			expect(loadSession()).toBeNull();
		}
	});

	it("rejects a non-http(s) homeserverUrl", () => {
		// Security-relevant: a stored session must not resurrect a homeserver on
		// a non-web scheme.
		for (const url of [
			"ftp://evil.example",
			"javascript:alert(1)",
			"notaurl",
			"",
		]) {
			localStorage.setItem(
				SESSION_KEY,
				JSON.stringify({ ...VALID, homeserverUrl: url }),
			);
			expect(loadSession()).toBeNull();
		}
	});

	it("accepts an http (non-TLS) homeserverUrl", () => {
		localStorage.setItem(
			SESSION_KEY,
			JSON.stringify({ ...VALID, homeserverUrl: "http://localhost:8008" }),
		);
		expect(loadSession()?.homeserverUrl).toBe("http://localhost:8008");
	});
});

describe("saveSession validation", () => {
	it("throws and writes nothing for an invalid session", () => {
		const bad = { ...VALID, homeserverUrl: "ftp://evil.example" };
		expect(() => saveSession(bad as Session)).toThrow(
			"Refusing to persist invalid session data",
		);
		expect(localStorage.getItem(SESSION_KEY)).toBeNull();
	});

	it("throws for an empty required field", () => {
		const bad = { ...VALID, accessToken: "" };
		expect(() => saveSession(bad as Session)).toThrow(
			"Refusing to persist invalid session data",
		);
	});

	it("throws for a missing required field", () => {
		const bad = { ...VALID };
		delete (bad as Record<string, unknown>).userId;
		expect(() => saveSession(bad as Session)).toThrow(
			"Refusing to persist invalid session data",
		);
	});
});

describe("clearSession", () => {
	it("removes a persisted session", () => {
		saveSession(VALID);
		expect(loadSession()).not.toBeNull();
		clearSession();
		expect(loadSession()).toBeNull();
		expect(localStorage.getItem(SESSION_KEY)).toBeNull();
	});

	it("is a no-op when nothing is stored", () => {
		expect(() => clearSession()).not.toThrow();
		expect(loadSession()).toBeNull();
	});

	it("also clears an un-migrated legacy session (no stale token left behind)", () => {
		localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(VALID));
		clearSession();
		expect(localStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
		expect(loadSession()).toBeNull();
	});
});

describe("legacy key migration", () => {
	it("migrates a legacy crust_session value to crust:session on load", () => {
		localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(VALID));
		expect(loadSession()).toEqual(VALID);
		// The value now lives under the new key and the legacy key is dropped.
		expect(localStorage.getItem(SESSION_KEY)).toBe(JSON.stringify(VALID));
		expect(localStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
	});

	it("prefers the new key and drops a stale coexisting legacy token", () => {
		const legacy = { ...VALID, deviceId: "OLD_DEVICE" };
		localStorage.setItem(SESSION_KEY, JSON.stringify(VALID));
		localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(legacy));
		expect(loadSession()).toEqual(VALID);
		// A still-valid legacy token must not linger once the new key is set.
		expect(localStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
		expect(localStorage.getItem(SESSION_KEY)).toBe(JSON.stringify(VALID));
	});

	it("recovers from a valid legacy token when the new key is unusable, then heals", () => {
		// The new key exists but is corrupt/invalid; a valid legacy token must be
		// recovered rather than deleted, so the user isn't stranded logged out.
		localStorage.setItem(SESSION_KEY, "not json {");
		localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(VALID));
		expect(loadSession()).toEqual(VALID);
		// The recovered value is promoted to the new key (overwriting the corrupt
		// one) and the legacy token is dropped, leaving a single clean copy.
		expect(localStorage.getItem(SESSION_KEY)).toBe(JSON.stringify(VALID));
		expect(localStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
	});

	it("keeps the legacy value when the migration write failed (no state loss)", () => {
		localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(VALID));
		// Storage rejects the migration write, so `crust:session` stays absent.
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("QuotaExceeded");
		});
		// The session still loads from the legacy key this session...
		expect(loadSession()).toEqual(VALID);
		// ...and the legacy value is preserved rather than dropped.
		expect(localStorage.getItem(LEGACY_SESSION_KEY)).toBe(
			JSON.stringify(VALID),
		);
	});
});
