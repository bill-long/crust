import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	accountCryptoDbPrefix,
	CRYPTO_DB_PREFIX,
} from "../client/cryptoRecovery";
import { pushMediaAuthToSw } from "../lib/authedMedia";
import {
	activeAccountId,
	clearSession,
	loadSession,
	loadSessions,
	type Session,
	saveSession,
	subscribeAccountScope,
	updateSession,
} from "./session";

// Keep the media-auth push observable without a service worker in jsdom.
vi.mock("../lib/authedMedia", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/authedMedia")>();
	return { ...actual, pushMediaAuthToSw: vi.fn() };
});

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

const BOB: Session = {
	accessToken: "syt_bob",
	userId: "@bob:example.com",
	deviceId: "DEVICE456",
	homeserverUrl: "https://matrix.example.com",
};

/** What `VALID` looks like once the store has assigned its crypto prefix. */
const SAVED: Session = {
	...VALID,
	cryptoPrefix: accountCryptoDbPrefix(VALID.userId),
};

/**
 * Seed the store with several accounts. Phase 1's login path replaces rather
 * than appends (see saveSession), so the multi-account states this store has to
 * survive are written directly, the way #533's switcher will create them.
 */
const seedStore = (sessions: Session[], activeUserId: string): void => {
	localStorage.setItem(SESSION_KEY, JSON.stringify({ activeUserId, sessions }));
};

/** The persisted multi-account value for a single, freshly added account. */
const storeOf = (...sessions: Session[]): string =>
	JSON.stringify({
		activeUserId: sessions[sessions.length - 1]?.userId ?? null,
		sessions,
	});

beforeEach(() => {
	localStorage.clear();
	vi.mocked(pushMediaAuthToSw).mockClear();
});
afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
});

describe("service-worker media auth push", () => {
	it("pushes the access token and homeserver on save", () => {
		saveSession(VALID);
		expect(pushMediaAuthToSw).toHaveBeenCalledWith({
			accessToken: VALID.accessToken,
			homeserverUrl: VALID.homeserverUrl,
		});
	});

	it("clears the worker's media auth on clear", () => {
		saveSession(VALID);
		vi.mocked(pushMediaAuthToSw).mockClear();
		clearSession();
		expect(pushMediaAuthToSw).toHaveBeenCalledWith(null);
	});

	it("does not push when the session fails validation", () => {
		// The token must never reach the worker for a session we refused to
		// persist; the throw happens before the push.
		expect(() => saveSession({ ...VALID, accessToken: "" })).toThrow();
		expect(pushMediaAuthToSw).not.toHaveBeenCalled();
	});
});

describe("saveSession / loadSession round-trip", () => {
	it("persists a valid session and loads it back", () => {
		saveSession(VALID);
		expect(loadSession()).toEqual(SAVED);
	});

	it("preserves extra unknown fields on the stored object", () => {
		// isSession only requires the known fields, so a forward-compatible
		// extra field survives the round-trip.
		const withExtra = { ...VALID, futureField: "x" };
		localStorage.setItem(SESSION_KEY, JSON.stringify(withExtra));
		// Migrated from the pre-multi-account shape, so it is also pinned to the
		// original crypto prefix.
		expect(loadSession()).toEqual({
			...withExtra,
			cryptoPrefix: CRYPTO_DB_PREFIX,
		});
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

	it("round-trips an OIDC session with refreshToken and oidc metadata", () => {
		const oidcSession: Session = {
			...VALID,
			refreshToken: "refresh-abc",
			oidc: {
				issuer: "https://auth.example.com/",
				clientId: "client-123",
			},
		};
		saveSession(oidcSession);
		expect(loadSession()).toEqual({
			...oidcSession,
			cryptoPrefix: accountCryptoDbPrefix(oidcSession.userId),
		});
	});

	it("rejects an empty refreshToken", () => {
		localStorage.setItem(
			SESSION_KEY,
			JSON.stringify({ ...VALID, refreshToken: "" }),
		);
		expect(loadSession()).toBeNull();
	});

	it("rejects a non-string refreshToken", () => {
		localStorage.setItem(
			SESSION_KEY,
			JSON.stringify({ ...VALID, refreshToken: 42 }),
		);
		expect(loadSession()).toBeNull();
	});

	it("rejects a malformed oidc block", () => {
		// Each missing/empty sub-field must invalidate the session: a partial
		// oidc block would break token refresh in confusing ways later.
		for (const oidc of [
			{ clientId: "c" }, // issuer missing
			{ issuer: "", clientId: "c" },
			{ issuer: "i", clientId: 7 },
			{ issuer: "i", clientId: "" },
			"not-an-object",
			[],
		]) {
			localStorage.setItem(SESSION_KEY, JSON.stringify({ ...VALID, oidc }));
			expect(loadSession()).toBeNull();
		}
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

/** A migrated pre-multi-account session, pinned to the original prefix. */
const LEGACY_SAVED: Session = { ...VALID, cryptoPrefix: CRYPTO_DB_PREFIX };

describe("legacy key migration", () => {
	it("migrates a legacy crust_session value to crust:session on load", () => {
		localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(VALID));
		expect(loadSession()).toEqual(LEGACY_SAVED);
		// The value now lives under the new key, in the multi-account shape, and
		// the legacy key is dropped.
		expect(localStorage.getItem(SESSION_KEY)).toBe(storeOf(LEGACY_SAVED));
		expect(localStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
	});

	it("prefers the new key and drops a stale coexisting legacy token", () => {
		const legacy = { ...VALID, deviceId: "OLD_DEVICE" };
		localStorage.setItem(SESSION_KEY, storeOf(SAVED));
		localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(legacy));
		expect(loadSession()).toEqual(SAVED);
		// A still-valid legacy token must not linger once the new key is set.
		expect(localStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
		expect(localStorage.getItem(SESSION_KEY)).toBe(storeOf(SAVED));
	});

	it("recovers from a valid legacy token when the new key is unusable, then heals", () => {
		// The new key exists but is corrupt/invalid; a valid legacy token must be
		// recovered rather than deleted, so the user isn't stranded logged out.
		localStorage.setItem(SESSION_KEY, "not json {");
		localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(VALID));
		expect(loadSession()).toEqual(LEGACY_SAVED);
		// The recovered value is promoted to the new key (overwriting the corrupt
		// one) and the legacy token is dropped, leaving a single clean copy.
		expect(localStorage.getItem(SESSION_KEY)).toBe(storeOf(LEGACY_SAVED));
		expect(localStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
	});

	it("keeps the legacy value when the migration write failed (no state loss)", () => {
		localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(VALID));
		// Storage rejects the migration write, so `crust:session` stays absent.
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("QuotaExceeded");
		});
		// The session still loads from the legacy key this session...
		expect(loadSession()).toEqual(LEGACY_SAVED);
		// ...and the legacy value is preserved rather than dropped.
		expect(localStorage.getItem(LEGACY_SESSION_KEY)).toBe(
			JSON.stringify(VALID),
		);
	});
});

describe("multi-account store", () => {
	it("carries several accounts, keeping the active one addressable", () => {
		seedStore([SAVED, BOB], BOB.userId);
		expect(loadSessions().map((a) => a.userId)).toEqual([
			VALID.userId,
			BOB.userId,
		]);
		expect(loadSession()?.userId).toBe(BOB.userId);
		expect(activeAccountId()).toBe(BOB.userId);
	});

	it("replaces the stored account on login rather than adding one", () => {
		// `/login` renders outside the auth guard, so it is reachable while an
		// account is logged in. Until the switcher ships an explicit add-account
		// action (#533), logging in must not leave the previous account's live
		// access token in storage with no UI to revoke it - nor let a logout drop
		// the user back into it without re-authenticating.
		saveSession(VALID);
		saveSession(BOB);
		expect(loadSessions().map((a) => a.userId)).toEqual([BOB.userId]);
		expect(localStorage.getItem(SESSION_KEY)).not.toContain(VALID.accessToken);
		clearSession();
		expect(loadSession()).toBeNull();
	});

	it("replaces an account rather than duplicating it on re-login", () => {
		saveSession(VALID);
		saveSession({ ...VALID, accessToken: "syt_new", deviceId: "DEVICE999" });
		expect(loadSessions()).toHaveLength(1);
		expect(loadSession()?.deviceId).toBe("DEVICE999");
	});

	it("removes only the active account on clear, activating what is left", () => {
		seedStore([SAVED, BOB], BOB.userId);
		clearSession();
		expect(loadSessions().map((a) => a.userId)).toEqual([VALID.userId]);
		expect(loadSession()?.userId).toBe(VALID.userId);
	});

	it("leaves no session key behind once the last account is removed", () => {
		saveSession(VALID);
		clearSession();
		expect(localStorage.getItem(SESSION_KEY)).toBeNull();
		expect(activeAccountId()).toBeNull();
	});

	it("updateSession rewrites one account without changing the active one", () => {
		seedStore([SAVED, BOB], BOB.userId);
		expect(updateSession({ ...VALID, accessToken: "syt_rotated" })).toBe(true);
		expect(
			loadSessions().find((a) => a.userId === VALID.userId)?.accessToken,
		).toBe("syt_rotated");
		expect(loadSession()?.userId).toBe(BOB.userId);
	});

	it("updateSession refuses to resurrect a removed account", () => {
		saveSession(VALID);
		expect(updateSession(BOB)).toBe(false);
		expect(loadSessions().map((a) => a.userId)).toEqual([VALID.userId]);
	});

	it("drops a corrupt account entry without logging the others out", () => {
		localStorage.setItem(
			SESSION_KEY,
			JSON.stringify({
				activeUserId: BOB.userId,
				sessions: [{ ...VALID, accessToken: "" }, BOB],
			}),
		);
		expect(loadSessions().map((a) => a.userId)).toEqual([BOB.userId]);
		expect(loadSession()?.userId).toBe(BOB.userId);
	});

	it("deduplicates accounts sharing a user ID", () => {
		localStorage.setItem(
			SESSION_KEY,
			JSON.stringify({
				activeUserId: VALID.userId,
				sessions: [VALID, { ...VALID, deviceId: "DUP" }],
			}),
		);
		expect(loadSessions()).toHaveLength(1);
		expect(loadSession()?.deviceId).toBe(VALID.deviceId);
	});

	it("heals an activeUserId that names no stored account", () => {
		localStorage.setItem(
			SESSION_KEY,
			JSON.stringify({ activeUserId: "@ghost:example.com", sessions: [BOB] }),
		);
		expect(loadSession()?.userId).toBe(BOB.userId);
	});

	it("reads an empty account list as logged out", () => {
		localStorage.setItem(
			SESSION_KEY,
			JSON.stringify({ activeUserId: null, sessions: [] }),
		);
		expect(loadSession()).toBeNull();
		expect(activeAccountId()).toBeNull();
	});
});

describe("crypto store prefixes", () => {
	it("gives a newly added account its own prefix", () => {
		saveSession(VALID);
		expect(loadSession()?.cryptoPrefix).toBe(
			accountCryptoDbPrefix(VALID.userId),
		);
		saveSession(BOB);
		expect(loadSession()?.cryptoPrefix).toBe(accountCryptoDbPrefix(BOB.userId));
		expect(accountCryptoDbPrefix(VALID.userId)).not.toBe(
			accountCryptoDbPrefix(BOB.userId),
		);
	});

	it("never lets a caller pick the prefix for an account being added", () => {
		// Building a session by spreading another account's is a real pattern (the
		// tests here do it). Honouring the carried prefix would point the new
		// account at the old one's crypto store, and logging either out would wipe
		// the other's keys.
		saveSession({ ...SAVED, userId: BOB.userId, deviceId: BOB.deviceId });
		expect(loadSession()?.cryptoPrefix).toBe(accountCryptoDbPrefix(BOB.userId));
		expect(loadSession()?.cryptoPrefix).not.toBe(SAVED.cryptoPrefix);
	});

	it("pins a migrated pre-multi-account session to the original prefix", () => {
		// Its IndexedDB store already exists under "crust" and cannot be renamed;
		// a derived prefix here would orphan it and force re-verification.
		localStorage.setItem(SESSION_KEY, JSON.stringify(VALID));
		expect(loadSession()?.cryptoPrefix).toBe(CRYPTO_DB_PREFIX);
	});

	it("keeps an account's prefix across re-login and token rotation", () => {
		localStorage.setItem(SESSION_KEY, JSON.stringify(VALID));
		expect(loadSession()?.cryptoPrefix).toBe(CRYPTO_DB_PREFIX);
		saveSession({ ...VALID, accessToken: "syt_relogin" });
		expect(loadSession()?.cryptoPrefix).toBe(CRYPTO_DB_PREFIX);
		updateSession({
			...VALID,
			accessToken: "syt_rotated",
			cryptoPrefix: "hax",
		});
		expect(loadSession()?.cryptoPrefix).toBe(CRYPTO_DB_PREFIX);
	});
});

describe("per-account storage keys", () => {
	const SETTINGS_KEY = "crust:settings";
	const LAST_ROOM_KEY = "crust:last-room";
	const PANE_WIDTHS_KEY = "crust:pane-widths";

	it("hands the pre-multi-account values to the migrated account", () => {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify({ zoomLevel: 150 }));
		localStorage.setItem(PANE_WIDTHS_KEY, JSON.stringify({ rooms: 240 }));
		localStorage.setItem(SESSION_KEY, JSON.stringify(VALID));

		expect(loadSession()?.userId).toBe(VALID.userId);
		expect(localStorage.getItem(`${SETTINGS_KEY}:${VALID.userId}`)).toBe(
			JSON.stringify({ zoomLevel: 150 }),
		);
		// Adopted, not copied: the unscoped value is gone, so the NEXT account
		// added cannot inherit it.
		expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
		// Install-global keys are untouched - pane widths belong to the browser
		// profile, not to whoever is logged in.
		expect(localStorage.getItem(PANE_WIDTHS_KEY)).toBe(
			JSON.stringify({ rooms: 240 }),
		);
	});

	it("hands them to the first account added on a logged-out install", () => {
		localStorage.setItem(LAST_ROOM_KEY, JSON.stringify({ roomId: "!r:x.com" }));
		saveSession(VALID);
		expect(localStorage.getItem(`${LAST_ROOM_KEY}:${VALID.userId}`)).toBe(
			JSON.stringify({ roomId: "!r:x.com" }),
		);
		saveSession(BOB);
		expect(localStorage.getItem(`${LAST_ROOM_KEY}:${BOB.userId}`)).toBeNull();
	});

	it("never overwrites an account's own value with the unscoped one", () => {
		localStorage.setItem(`${SETTINGS_KEY}:${VALID.userId}`, '{"zoomLevel":90}');
		localStorage.setItem(SETTINGS_KEY, '{"zoomLevel":150}');
		saveSession(VALID);
		expect(localStorage.getItem(`${SETTINGS_KEY}:${VALID.userId}`)).toBe(
			'{"zoomLevel":90}',
		);
		expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
	});
});

describe("migration idempotence and tolerance", () => {
	it("is idempotent across repeated loads", () => {
		localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(VALID));
		const first = loadSession();
		const afterFirst = localStorage.getItem(SESSION_KEY);
		expect(loadSession()).toEqual(first);
		expect(loadSession()).toEqual(first);
		expect(localStorage.getItem(SESSION_KEY)).toBe(afterFirst);
		expect(localStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
	});

	it("recovers a legacy token when every stored account is invalid", () => {
		// The new key parses but yields no usable account, so it must not shadow
		// (and delete) a legacy token that still works.
		localStorage.setItem(
			SESSION_KEY,
			JSON.stringify({
				activeUserId: VALID.userId,
				sessions: [{ ...VALID, accessToken: "" }],
			}),
		);
		localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(VALID));
		expect(loadSession()).toEqual(LEGACY_SAVED);
		expect(localStorage.getItem(SESSION_KEY)).toBe(storeOf(LEGACY_SAVED));
		expect(localStorage.getItem(LEGACY_SESSION_KEY)).toBeNull();
	});

	it("tolerates a corrupt value under both keys", () => {
		localStorage.setItem(SESSION_KEY, "not json {");
		localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify({ nope: true }));
		expect(loadSession()).toBeNull();
		expect(loadSessions()).toEqual([]);
		expect(activeAccountId()).toBeNull();
	});

	it("does not adopt per-account values when the migration write fails", () => {
		localStorage.setItem("crust:settings", '{"zoomLevel":150}');
		localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(VALID));
		// Only the session write is rejected, so the per-account writes WOULD
		// succeed: the values must stay put anyway. Moving them onto an account
		// that did not persist would strand them under a key nothing reads.
		const realSetItem = Storage.prototype.setItem;
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
			this: Storage,
			key: string,
			value: string,
		) {
			if (key === SESSION_KEY) throw new Error("QuotaExceeded");
			realSetItem.call(this, key, value);
		});
		expect(loadSession()).toEqual(LEGACY_SAVED);
		vi.restoreAllMocks();
		// Nothing was moved, so the retry on the next load still finds both.
		expect(localStorage.getItem("crust:settings")).toBe('{"zoomLevel":150}');
		expect(localStorage.getItem(`crust:settings:${VALID.userId}`)).toBeNull();
		expect(localStorage.getItem(LEGACY_SESSION_KEY)).toBe(
			JSON.stringify(VALID),
		);
	});
});

describe("account scope notification", () => {
	it("fires on login, logout and switch, but not on a token refresh", () => {
		const seen: Array<string | null> = [];
		const unsubscribe = subscribeAccountScope((id) => seen.push(id));
		try {
			saveSession(VALID);
			// Neither a token rotation nor a re-login as the account already
			// active changes what the per-account stores are bound to.
			updateSession({ ...VALID, accessToken: "syt_rotated" });
			saveSession({ ...VALID, accessToken: "syt_relogin" });
			saveSession(BOB);
			// A logout that leaves another account behind rebinds to it.
			seedStore([SAVED, BOB], BOB.userId);
			clearSession();
			expect(seen).toEqual([VALID.userId, BOB.userId, VALID.userId]);
		} finally {
			unsubscribe();
		}
	});

	it("stops notifying an unsubscribed listener", () => {
		const seen: Array<string | null> = [];
		subscribeAccountScope((id) => seen.push(id))();
		saveSession(VALID);
		expect(seen).toEqual([]);
	});
});
