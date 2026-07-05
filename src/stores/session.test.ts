import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearSession,
	loadSession,
	type Session,
	saveSession,
} from "./session";

// The persisted key is module-private; the tests that poke localStorage
// directly reference it by its literal value.
const SESSION_KEY = "crust_session";

const VALID: Session = {
	accessToken: "syt_accesstoken",
	userId: "@alice:example.com",
	deviceId: "DEVICE123",
	homeserverUrl: "https://matrix.example.com",
};

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

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

	it("throws for a missing field", () => {
		const bad = { ...VALID, accessToken: "" };
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
});
