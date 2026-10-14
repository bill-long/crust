import { createClient } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../stores/session";
import {
	addSession,
	loadSession,
	loadSessions,
	saveSession,
} from "../../stores/session";

import { createOidcTokenRefreshCallback } from "./oidcRefresh";

const refreshFixture = {
	nextTokens: { accessToken: "new-access", refreshToken: "new-refresh" } as {
		accessToken: string;
		refreshToken?: string;
	},
};
const PASSWORD_SESSION: Session = {
	accessToken: "access-old",
	userId: "@alice:example.com",
	deviceId: "DEVICE42",
	homeserverUrl: "https://matrix.example.com",
};

const OIDC_SESSION: Session = {
	...PASSWORD_SESSION,
	refreshToken: "refresh-old",
	oidc: {
		issuer: "https://auth.example.com/",
		clientId: "client-xyz",
	},
};

/** The account persisted for `userId`, or undefined if it is not stored. */
const stored = (userId = PASSWORD_SESSION.userId): Session | undefined =>
	loadSessions().find((session) => session.userId === userId);

beforeEach(() => {
	localStorage.clear();
	refreshFixture.nextTokens = {
		accessToken: "new-access",
		refreshToken: "new-refresh",
	};
});
afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("createOidcTokenRefreshCallback", () => {
	it("waits for a concurrent login before reading and updating the account list", async () => {
		saveSession(OIDC_SESSION);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const request = vi.fn(
			async (
				_name: string,
				_options: unknown,
				operation: () => Promise<unknown>,
			) => {
				await gate;
				return operation();
			},
		);
		vi.stubGlobal("navigator", { locks: { request } });
		const refresh = createOidcTokenRefreshCallback(OIDC_SESSION);
		if (!refresh) throw new Error("expected a refresh function");
		const pending = refresh(refreshFixture.nextTokens);
		await vi.waitFor(() => expect(request).toHaveBeenCalled());
		expect(stored()?.accessToken).toBe("access-old");
		addSession({
			...PASSWORD_SESSION,
			userId: "@bob:example.com",
			deviceId: "B",
		});
		release();
		await pending;
		expect(loadSessions()).toHaveLength(2);
		expect(stored()?.accessToken).toBe("new-access");
		expect(loadSession()?.userId).toBe("@bob:example.com");
	});
	it("returns undefined for a password session", () => {
		expect(createOidcTokenRefreshCallback(PASSWORD_SESSION)).toBeUndefined();
	});

	it("provides persistence for OAuth sessions even without a refresh token", () => {
		const session = { ...OIDC_SESSION };
		delete session.refreshToken;
		expect(createOidcTokenRefreshCallback(session)).toBeTypeOf("function");
	});
	it("persists rotated tokens back into the stored session on refresh", async () => {
		saveSession(OIDC_SESSION);
		const fn = createOidcTokenRefreshCallback(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn(refreshFixture.nextTokens);

		expect(stored()?.accessToken).toBe("new-access");
		expect(stored()?.refreshToken).toBe("new-refresh");
		// Untouched fields survive the rotation.
		expect(stored()?.userId).toBe("@alice:example.com");
		expect(stored()?.oidc).toEqual(OIDC_SESSION.oidc);
	});

	it("keeps the stored refresh token when the OP does not rotate it", async () => {
		refreshFixture.nextTokens = { accessToken: "new-access" };
		saveSession(OIDC_SESSION);
		const fn = createOidcTokenRefreshCallback(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn(refreshFixture.nextTokens);

		expect(stored()?.accessToken).toBe("new-access");
		expect(stored()?.refreshToken).toBe("refresh-old");
	});

	it("keeps the stored refresh token when the OP rotates it to empty", async () => {
		// An empty refresh_token is "not rotated", not a new value: storing "" would
		// fail session validation and lose the new access token with it.
		refreshFixture.nextTokens = {
			accessToken: "new-access",
			refreshToken: "",
		};
		saveSession(OIDC_SESSION);
		const fn = createOidcTokenRefreshCallback(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn(refreshFixture.nextTokens);

		expect(stored()?.accessToken).toBe("new-access");
		expect(stored()?.refreshToken).toBe("refresh-old");
	});

	it("does not persist into a password session that replaced the OIDC one", async () => {
		saveSession(PASSWORD_SESSION);
		const fn = createOidcTokenRefreshCallback(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn(refreshFixture.nextTokens);

		expect(stored()?.accessToken).toBe("access-old");
		expect(stored()?.refreshToken).toBeUndefined();
	});

	it("does not persist into a different account's OIDC session", async () => {
		const otherSession: Session = {
			...OIDC_SESSION,
			userId: "@bob:example.com",
			deviceId: "DEVICE99",
		};
		saveSession(otherSession);
		const fn = createOidcTokenRefreshCallback(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn(refreshFixture.nextTokens);

		// The refreshing account is not logged in at all any more, so nothing is
		// written - and in particular the account that IS logged in keeps its own
		// tokens rather than being handed another account's.
		expect(stored()).toBeUndefined();
		expect(stored("@bob:example.com")?.accessToken).toBe("access-old");
		expect(stored("@bob:example.com")?.refreshToken).toBe("refresh-old");
	});

	it("persists into its own account while a different one is active", async () => {
		// A refresh can land after the user switched accounts (#532). It belongs
		// to the account it was issued for: that account's tokens are updated,
		// and the active account is neither written to nor switched away from.
		const other: Session = {
			...PASSWORD_SESSION,
			accessToken: "bob-access",
			userId: "@bob:example.com",
			deviceId: "DEVICE99",
		};
		// Two accounts is a state only the switcher (#533) creates, so seed it the
		// way it will be persisted rather than through the single-account login path.
		localStorage.setItem(
			"crust:session",
			JSON.stringify({
				activeUserId: other.userId,
				sessions: [OIDC_SESSION, other],
			}),
		);
		const fn = createOidcTokenRefreshCallback(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn(refreshFixture.nextTokens);

		expect(stored()?.accessToken).toBe("new-access");
		expect(stored("@bob:example.com")?.accessToken).toBe("bob-access");
		expect(loadSession()?.userId).toBe("@bob:example.com");
	});

	it("does not throw when the session was cleared before a refresh lands", async () => {
		const fn = createOidcTokenRefreshCallback(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");
		localStorage.clear();

		await expect(fn(refreshFixture.nextTokens)).resolves.toBeUndefined();
		expect(localStorage.getItem("crust:session")).toBeNull();
		expect(loadSession()).toBeNull();
	});
});

it("lets SDK 44 refresh an expired request and persist rotated OAuth tokens", async () => {
	saveSession(OIDC_SESSION);
	const fetchImpl = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === "https://auth.example.com/token") {
				expect(String(init?.body)).toContain("refresh_token=refresh-old");
				return new Response(
					JSON.stringify({
						access_token: "new-access",
						refresh_token: "new-refresh",
						token_type: "Bearer",
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			if (
				new Headers(init?.headers).get("Authorization") === "Bearer access-old"
			)
				return new Response(
					JSON.stringify({ errcode: "M_UNKNOWN_TOKEN", error: "expired" }),
					{ status: 401, headers: { "Content-Type": "application/json" } },
				);
			return new Response(
				JSON.stringify({
					user_id: OIDC_SESSION.userId,
					device_id: OIDC_SESSION.deviceId,
				}),
				{ headers: { "Content-Type": "application/json" } },
			);
		},
	);
	vi.stubGlobal("fetch", fetchImpl);
	const callback = createOidcTokenRefreshCallback(OIDC_SESSION);
	if (!callback) throw new Error("Missing callback");
	const client = createClient({
		baseUrl: OIDC_SESSION.homeserverUrl,
		userId: OIDC_SESSION.userId,
		deviceId: OIDC_SESSION.deviceId,
		accessToken: OIDC_SESSION.accessToken,
		refreshToken: "refresh-old",
		oauthClientId: "client-xyz",
		onTokenRefresh: callback,
		fetchFn: fetchImpl,
	});
	client.http.opts.authMetadataCallback = async () =>
		({
			issuer: "https://auth.example.com/",
			token_endpoint: "https://auth.example.com/token",
		}) as never;
	await expect(client.whoami()).resolves.toMatchObject({
		user_id: OIDC_SESSION.userId,
	});
	await vi.waitFor(() => expect(stored()?.accessToken).toBe("new-access"));
	expect(stored()?.refreshToken).toBe("new-refresh");
});
