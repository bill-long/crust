import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createClientMock = vi.hoisted(() => vi.fn());
vi.mock("matrix-js-sdk", () => ({
	createClient: (...args: unknown[]) => createClientMock(...args),
	Method: { Post: "POST" },
}));

import {
	addSession,
	loadSession,
	loadSessions,
	type Session,
	saveSession,
} from "../stores/session";
import { logOutAccount, REVOKE_TIMEOUT_MS } from "./accountLogout";

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

let revoke: ReturnType<typeof vi.fn>;
let stopClient: ReturnType<typeof vi.fn>;
let abort: ReturnType<typeof vi.fn>;
let clearStores: ReturnType<typeof vi.fn>;
let startClient: ReturnType<typeof vi.fn>;

beforeEach(() => {
	localStorage.clear();
	revoke = vi.fn(async () => {});
	stopClient = vi.fn();
	abort = vi.fn();
	clearStores = vi.fn(async () => {});
	startClient = vi.fn(async () => {});
	createClientMock.mockReset();
	createClientMock.mockReturnValue({
		clearStores,
		startClient,
		stopClient,
		http: { abort, authedRequest: revoke },
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
});

/** The stored account for `userId`, or undefined once it is gone. */
const stored = (userId: string): Session | undefined =>
	loadSessions().find((s) => s.userId === userId);

describe("logOutAccount", () => {
	it("gives the throwaway client a way to refresh a stale OAuth token", () => {
		// An inactive account's access token is stale by definition; for an
		// MSC3861 session that is the routine case, and without a refresh the
		// revoke 401s and the device survives on the server.
		const oidc: Session = {
			...ALICE,
			refreshToken: "refresh-abc",
			oidc: { issuer: "https://auth.example.com/", clientId: "client-1" },
		};
		saveSession(oidc);
		void logOutAccount(oidc);
		expect(createClientMock.mock.calls[0]?.[0]).toMatchObject({
			accessToken: oidc.accessToken,
		});
		const opts = createClientMock.mock.calls[0]?.[0] as {
			tokenRefreshFunction?: unknown;
			refreshToken?: unknown;
		};
		expect(opts?.tokenRefreshFunction).toBeTypeOf("function");
		// Both halves are needed: the function has nothing to present without
		// the token, so omitting it makes the refresher dead weight.
		expect(opts?.refreshToken).toBe(oidc.refreshToken);
	});

	it("revokes the token with that account's own credentials", async () => {
		saveSession(ALICE);
		addSession(BOB);

		await logOutAccount(ALICE);

		expect(createClientMock).toHaveBeenCalledWith({
			baseUrl: ALICE.homeserverUrl,
			accessToken: ALICE.accessToken,
			userId: ALICE.userId,
			deviceId: ALICE.deviceId,
		});
		// Stopped and aborted first, as `client.logout(true)` would - a stalled
		// long-poll must not keep running on a token about to be invalidated -
		// and revoked with keepalive so the request outlives whatever the caller
		// navigates to.
		expect(stopClient).toHaveBeenCalledOnce();
		expect(abort).toHaveBeenCalledOnce();
		expect(revoke).toHaveBeenCalledWith(
			"POST",
			"/logout",
			undefined,
			undefined,
			{ keepAlive: true },
		);
		const [stopAt] = stopClient.mock.invocationCallOrder;
		const [abortAt] = abort.mock.invocationCallOrder;
		const [revokeAt] = revoke.mock.invocationCallOrder;
		expect(stopAt).toBeLessThan(abortAt);
		expect(abortAt).toBeLessThan(revokeAt);
	});

	it("still revokes when the client stop throws", async () => {
		// `stopClient` runs the crypto backend's stop, which can throw. The
		// device ending up revoked is the point of the whole call, so the stop
		// failing must not skip the request (`stopClientFully` owns the retry
		// and the flag; its own suite locks those).
		saveSession(ALICE);
		addSession(BOB);
		stopClient.mockImplementation(() => {
			throw new Error("crypto backend stop failed");
		});

		await expect(logOutAccount(ALICE)).resolves.toBe(true);

		expect(abort).toHaveBeenCalledOnce();
		expect(revoke).toHaveBeenCalledOnce();
		expect(stored(ALICE.userId)).toBeUndefined();
	});

	it("gives up on a revoke the server never answers", async () => {
		// The same hang the foreground logout bounds (#555): this runs under the
		// switcher's single-flight guard, so an unbounded await here would lock
		// out switching, adding and logging out for the life of the document.
		vi.useFakeTimers();
		try {
			saveSession(ALICE);
			addSession(BOB);
			revoke.mockImplementation(() => new Promise<void>(() => {}));

			const done = logOutAccount(ALICE);
			await vi.advanceTimersByTimeAsync(REVOKE_TIMEOUT_MS);

			await expect(done).resolves.toBe(true);
			expect(stored(ALICE.userId)).toBeUndefined();
			expect(clearStores).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("wipes ONLY that account's crypto store", async () => {
		saveSession(ALICE);
		addSession(BOB);
		const alice = stored(ALICE.userId);
		const bob = stored(BOB.userId);
		if (!alice || !bob) throw new Error("fixture");

		await logOutAccount(alice);

		expect(clearStores).toHaveBeenCalledWith({
			cryptoDatabasePrefix: alice.cryptoPrefix,
		});
		expect(clearStores).not.toHaveBeenCalledWith({
			cryptoDatabasePrefix: bob.cryptoPrefix,
		});
	});

	it("leaves the account that is still logged in untouched", async () => {
		saveSession(ALICE);
		addSession(BOB);

		await logOutAccount(ALICE);

		expect(stored(ALICE.userId)).toBeUndefined();
		expect(stored(BOB.userId)?.accessToken).toBe(BOB.accessToken);
		expect(loadSession()?.userId).toBe(BOB.userId);
	});

	it("still forgets the account when the revoke fails", async () => {
		// The user asked for it to be gone, and retrying needs credentials we
		// are about to discard - so the local half runs either way.
		saveSession(ALICE);
		addSession(BOB);
		revoke.mockRejectedValueOnce(new Error("token already expired"));

		await logOutAccount(ALICE);

		expect(stored(ALICE.userId)).toBeUndefined();
		expect(clearStores).toHaveBeenCalledOnce();
	});

	it("still forgets the account when the store wipe fails", async () => {
		saveSession(ALICE);
		addSession(BOB);
		clearStores.mockRejectedValueOnce(new Error("blocked"));

		await logOutAccount(ALICE);

		expect(stored(ALICE.userId)).toBeUndefined();
	});

	it("gives up on a wipe that never settles", async () => {
		// `deleteDatabase` BLOCKS while another window holds that account's store
		// open and the SDK only logs it. This runs under the switcher's
		// single-flight guard, which would otherwise stay set for the life of the
		// module and lock out switching, adding and logging out.
		vi.useFakeTimers();
		try {
			saveSession(ALICE);
			addSession(BOB);
			clearStores.mockImplementation(() => new Promise<void>(() => {}));

			const done = logOutAccount(ALICE);
			await vi.advanceTimersByTimeAsync(60_000);

			await expect(done).resolves.toBe(true);
			expect(stored(ALICE.userId)).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("never starts the throwaway client", async () => {
		// clearStores refuses to run on a running client, and a second syncing
		// client is exactly what the switch-only design avoids.
		saveSession(ALICE);
		await logOutAccount(ALICE);
		expect(startClient).not.toHaveBeenCalled();
	});
});
