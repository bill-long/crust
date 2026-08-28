import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createClientMock = vi.hoisted(() => vi.fn());
vi.mock("matrix-js-sdk", () => ({
	createClient: (...args: unknown[]) => createClientMock(...args),
}));

import {
	addSession,
	loadSession,
	loadSessions,
	type Session,
	saveSession,
} from "../stores/session";
import { logOutAccount } from "./accountLogout";

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

let logout: ReturnType<typeof vi.fn>;
let clearStores: ReturnType<typeof vi.fn>;
let startClient: ReturnType<typeof vi.fn>;

beforeEach(() => {
	localStorage.clear();
	logout = vi.fn(async () => {});
	clearStores = vi.fn(async () => {});
	startClient = vi.fn(async () => {});
	createClientMock.mockReset();
	createClientMock.mockReturnValue({ logout, clearStores, startClient });
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
		expect(
			(
				createClientMock.mock.calls[0]?.[0] as {
					tokenRefreshFunction?: unknown;
				}
			)?.tokenRefreshFunction,
		).toBeTypeOf("function");
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
		expect(logout).toHaveBeenCalledWith(true);
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
		logout.mockRejectedValueOnce(new Error("token already expired"));

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

	it("never starts the throwaway client", async () => {
		// clearStores refuses to run on a running client, and a second syncing
		// client is exactly what the switch-only design avoids.
		saveSession(ALICE);
		await logOutAccount(ALICE);
		expect(startClient).not.toHaveBeenCalled();
	});
});
