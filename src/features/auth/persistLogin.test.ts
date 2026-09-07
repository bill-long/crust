import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_SCOPED_KEYS, accountScopedKey } from "../../lib/storageKeys";
import {
	clearLogoutResidue,
	rememberLogoutSession,
} from "../../stores/logoutResidue";
import {
	addSession,
	commitLoginSession,
	isAccountScopeFrozen,
	loadSessions,
	MAX_ACCOUNTS,
	type Session,
	saveSession,
	unfreezeAccountScope,
} from "../../stores/session";
import { mockLoginLocks } from "../../test/loginLocks";

const revoke = vi.fn(async (_session: Session) => {});
vi.mock("../../client/accountLogout", () => ({
	revokeAccountToken: (session: Session) => revoke(session),
}));

import { persistLogin } from "./persistLogin";

const alice: Session = {
	userId: "@alice:example.org",
	deviceId: "A",
	accessToken: "alice-token",
	homeserverUrl: "https://example.org",
};
const bob: Session = {
	...alice,
	userId: "@bob:example.org",
	deviceId: "B",
	accessToken: "bob-token",
};

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	clearLogoutResidue();
	unfreezeAccountScope();
	const hashes = new Map<string, ArrayBuffer>();
	vi.stubGlobal("crypto", {
		subtle: {
			digest: async (_algorithm: string, data: Uint8Array) => {
				const key = new TextDecoder().decode(data);
				if (!hashes.has(key)) {
					const bytes = new Uint8Array(32);
					bytes[0] = hashes.size + 1;
					hashes.set(key, bytes.buffer);
				}
				return hashes.get(key);
			},
		},
	});
	mockLoginLocks();
	revoke.mockClear();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	unfreezeAccountScope();
});

describe("persistLogin (#551)", () => {
	it("preserves an account created after the form opened, without a running tab", async () => {
		saveSession(alice);
		expect(await persistLogin(bob, false)).toBe(true);
		expect(loadSessions().map((s) => s.userId)).toEqual([
			alice.userId,
			bob.userId,
		]);
		expect(isAccountScopeFrozen()).toBe(true);
		expect(revoke).not.toHaveBeenCalled();
	});
	it("serializes two simultaneous plain logins", async () => {
		await Promise.all([persistLogin(alice, false), persistLogin(bob, false)]);
		expect(loadSessions()).toHaveLength(2);
	});
	it.each([false, true])(
		"refuses a second device for an existing account (adding=%s)",
		async (adding) => {
			saveSession(alice);
			const fresh = { ...alice, accessToken: "new-token", deviceId: "NEW" };
			await expect(persistLogin(fresh, adding)).rejects.toThrow(
				"already signed in",
			);
			expect(loadSessions()[0]?.accessToken).toBe(alice.accessToken);
			expect(revoke).toHaveBeenCalledWith(fresh);
			expect(isAccountScopeFrozen()).toBe(false);
		},
	);
	it("recovers logout residue and preserves a healthy sibling and its settings", async () => {
		saveSession(alice);
		addSession(bob);
		for (const base of ACCOUNT_SCOPED_KEYS) {
			localStorage.setItem(accountScopedKey(base, alice.userId), "old");
			localStorage.setItem(accountScopedKey(base, bob.userId), "keep");
		}
		await rememberLogoutSession(alice);
		await persistLogin(
			{ ...alice, deviceId: "NEW", accessToken: "new" },
			false,
		);
		expect(loadSessions().map((s) => s.accessToken)).toEqual([
			bob.accessToken,
			"new",
		]);
		for (const base of ACCOUNT_SCOPED_KEYS) {
			expect(
				localStorage.getItem(accountScopedKey(base, alice.userId)),
			).toBeNull();
			expect(localStorage.getItem(accountScopedKey(base, bob.userId))).toBe(
				"keep",
			);
		}
	});
	it("does not let an old logout marker replace a refreshed credential", async () => {
		await rememberLogoutSession(alice);
		saveSession({ ...alice, accessToken: "refreshed" });
		await expect(
			persistLogin({ ...alice, deviceId: "NEW" }, false),
		).rejects.toThrow("already signed in");
		expect(loadSessions()[0]?.accessToken).toBe("refreshed");
	});
	it("rechecks the exact credential after async preparation", () => {
		saveSession({ ...alice, accessToken: "refreshed" });
		commitLoginSession(bob, [alice]);
		expect(loadSessions()).toHaveLength(2);
	});
	it("revokes only the incoming token when full", async () => {
		for (let i = 0; i < MAX_ACCOUNTS; i++)
			addSession({ ...alice, userId: `@user${i}:example.org` });
		await expect(persistLogin(bob, false)).rejects.toThrow("accounts at once");
		expect(loadSessions()).toHaveLength(MAX_ACCOUNTS);
		expect(revoke).toHaveBeenCalledExactlyOnceWith(bob);
	});
	it("a refused write preserves settings and residue so a retry can recover", async () => {
		saveSession(alice);
		await rememberLogoutSession(alice);
		const key = accountScopedKey(ACCOUNT_SCOPED_KEYS[0], alice.userId);
		localStorage.setItem(key, "keep until committed");
		const set = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementationOnce(() => {
				throw new Error("QuotaExceeded");
			});
		await expect(persistLogin(bob, false)).rejects.toThrow("QuotaExceeded");
		expect(loadSessions()[0]?.userId).toBe(alice.userId);
		expect(localStorage.getItem(key)).toBe("keep until committed");
		expect(isAccountScopeFrozen()).toBe(false);
		expect(revoke).toHaveBeenCalledWith(bob);
		set.mockRestore();
		await persistLogin(bob, false);
		expect(loadSessions().map((s) => s.userId)).toEqual([bob.userId]);
	});
	it("preserves accounts when browser coordination is unavailable", async () => {
		saveSession(alice);
		vi.stubGlobal("navigator", {});
		await expect(persistLogin(bob, false)).rejects.toThrow("updated browser");
		expect(loadSessions()).toHaveLength(1);
		expect(revoke).toHaveBeenCalledWith(bob);
	});

	it("carries exact logout evidence through an OAuth document replacement", async () => {
		await rememberLogoutSession(alice);
		vi.resetModules();
		const fresh = await import("../../stores/logoutResidue");
		expect(await fresh.logoutResidue([alice, bob])).toEqual([alice]);
		fresh.clearLogoutResidue();
	});

	it("recovers in the same document when sessionStorage refuses the marker", async () => {
		saveSession(alice);
		const original = Storage.prototype.setItem;
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
			this: Storage,
			key,
			value,
		) {
			if (this === sessionStorage) throw new Error("storage denied");
			original.call(this, key, value);
		});
		await rememberLogoutSession(alice);
		await persistLogin(bob, false);
		expect(loadSessions().map((s) => s.userId)).toEqual([bob.userId]);
	});
});
