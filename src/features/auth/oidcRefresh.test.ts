import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../stores/session";
import { saveSession } from "../../stores/session";

// Mock the SDK boundary: a fake OidcTokenRefresher that records constructor
// args and lets each test script what a refresh yields, plus a stubbed
// decodeIdToken. What stays under test is OUR wiring: constructor argument
// mapping, the password-session no-op, corrupt-token tolerance, and the
// persistTokens override writing rotated tokens into the session store.
const decodeIdTokenMock = vi.hoisted(() => vi.fn());
vi.mock("matrix-js-sdk", () => {
	class FakeOidcTokenRefresher {
		static instances: unknown[][] = [];
		static nextTokens: { accessToken: string; refreshToken?: string } = {
			accessToken: "new-access",
			refreshToken: "new-refresh",
		};

		constructor(...args: unknown[]) {
			FakeOidcTokenRefresher.instances.push(args);
		}

		async doRefreshAccessToken(refreshToken: string): Promise<{
			accessToken: string;
			refreshToken?: string;
		}> {
			await this.persistTokens({
				...FakeOidcTokenRefresher.nextTokens,
			});
			return { ...FakeOidcTokenRefresher.nextTokens, refreshToken };
		}

		// The underscore prefix marks the parameter as intentionally unused.
		protected async persistTokens(_tokens: {
			accessToken: string;
			refreshToken?: string;
		}): Promise<void> {}
	}
	return {
		decodeIdToken: decodeIdTokenMock,
		OidcTokenRefresher: FakeOidcTokenRefresher,
		// The direct refresh path throws this on invalid_grant; a plain Error
		// subclass preserves the instanceof semantics under test.
		TokenRefreshLogoutError: class TokenRefreshLogoutError extends Error {},
	};
});

import { OidcTokenRefresher } from "matrix-js-sdk";
import { createOidcTokenRefreshFn } from "./oidcRefresh";

type FakeClass = typeof OidcTokenRefresher & {
	instances: unknown[][];
	nextTokens: { accessToken: string; refreshToken?: string };
};
const fake = OidcTokenRefresher as unknown as FakeClass;

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
		idToken: "header.payload.signature",
		tokenEndpoint: "https://auth.example.com/token",
	},
};

/** OIDC session for an OP that issues no ID tokens (Continuwuity shape). */
const NO_ID_TOKEN_SESSION: Session = {
	...PASSWORD_SESSION,
	refreshToken: "refresh-old",
	oidc: {
		issuer: "https://auth.example.com/",
		clientId: "client-xyz",
		tokenEndpoint: "https://auth.example.com/token",
	},
};

beforeEach(() => {
	localStorage.clear();
	fake.instances = [];
	fake.nextTokens = { accessToken: "new-access", refreshToken: "new-refresh" };
	decodeIdTokenMock.mockReturnValue({ sub: "@alice:example.com" });
});
afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("createOidcTokenRefreshFn", () => {
	it("returns undefined for a password session", () => {
		expect(createOidcTokenRefreshFn(PASSWORD_SESSION)).toBeUndefined();
		expect(fake.instances).toHaveLength(0);
	});

	it("returns undefined when the OIDC session has no refresh token", () => {
		const session: Session = { ...OIDC_SESSION };
		delete session.refreshToken;
		expect(createOidcTokenRefreshFn(session)).toBeUndefined();
		expect(fake.instances).toHaveLength(0);
	});

	it("maps the session into refresher constructor arguments", () => {
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		expect(fn).toBeTypeOf("function");
		expect(fake.instances).toHaveLength(1);
		const [issuer, clientId, redirectUri, deviceId, claims] = fake.instances[0];
		expect(issuer).toBe("https://auth.example.com/");
		expect(clientId).toBe("client-xyz");
		expect(redirectUri).toBe(`${window.location.origin}/login/callback`);
		expect(deviceId).toBe("DEVICE42");
		expect(claims).toEqual({ sub: "@alice:example.com" });
		expect(decodeIdTokenMock).toHaveBeenCalledWith("header.payload.signature");
	});

	it("returns undefined (and warns) when the persisted ID token is corrupt", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		decodeIdTokenMock.mockImplementation(() => {
			throw new Error("Invalid token");
		});

		expect(createOidcTokenRefreshFn(OIDC_SESSION)).toBeUndefined();
		expect(warn).toHaveBeenCalled();
	});

	it("persists rotated tokens back into the stored session on refresh", async () => {
		saveSession(OIDC_SESSION);
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn("refresh-old");

		const stored = JSON.parse(localStorage.getItem("crust:session") ?? "{}");
		expect(stored.accessToken).toBe("new-access");
		expect(stored.refreshToken).toBe("new-refresh");
		// Untouched fields survive the rotation.
		expect(stored.userId).toBe("@alice:example.com");
		expect(stored.oidc).toEqual(OIDC_SESSION.oidc);
	});

	it("keeps the stored refresh token when the OP does not rotate it", async () => {
		fake.nextTokens = { accessToken: "new-access" };
		saveSession(OIDC_SESSION);
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn("refresh-old");

		const stored = JSON.parse(localStorage.getItem("crust:session") ?? "{}");
		expect(stored.accessToken).toBe("new-access");
		expect(stored.refreshToken).toBe("refresh-old");
	});

	it("does not throw when the session was cleared before a refresh lands", async () => {
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");
		localStorage.clear();

		await expect(fn("refresh-old")).resolves.toBeDefined();
		expect(localStorage.getItem("crust:session")).toBeNull();
	});

	it("does not persist into a password session that replaced the OIDC one", async () => {
		// The user logged out of the OIDC session and back in with a password
		// since this window booted; a late refresh from the old session must
		// not overwrite the replacement's tokens.
		saveSession(PASSWORD_SESSION);
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn("refresh-old");

		const stored = JSON.parse(localStorage.getItem("crust:session") ?? "{}");
		expect(stored.accessToken).toBe("access-old");
		expect(stored.refreshToken).toBeUndefined();
	});

	it("does not persist into a different account's OIDC session", async () => {
		const otherSession: Session = {
			...OIDC_SESSION,
			userId: "@bob:example.com",
			deviceId: "DEVICE99",
		};
		saveSession(otherSession);
		const fn = createOidcTokenRefreshFn(OIDC_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await fn("refresh-old");

		const stored = JSON.parse(localStorage.getItem("crust:session") ?? "{}");
		expect(stored.accessToken).toBe("access-old");
		expect(stored.refreshToken).toBe("refresh-old");
		expect(stored.userId).toBe("@bob:example.com");
	});
});

describe("direct refresh path (OP issues no ID tokens)", () => {
	function stubRefreshEndpoint(
		handler: () => Promise<{
			status: number;
			body: unknown;
		}>,
	): ReturnType<typeof vi.fn> {
		const fetchMock = vi.fn(async () => {
			const { status, body } = await handler();
			return {
				ok: status >= 200 && status < 300,
				status,
				json: async () => body,
			} as Response;
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("takes the direct path (not the SDK refresher) without an idToken", () => {
		const fn = createOidcTokenRefreshFn(NO_ID_TOKEN_SESSION);
		expect(fn).toBeTypeOf("function");
		expect(fake.instances).toHaveLength(0);
	});

	it("refreshes via the persisted token endpoint and persists rotated tokens", async () => {
		saveSession(NO_ID_TOKEN_SESSION);
		const fetchMock = stubRefreshEndpoint(async () => ({
			status: 200,
			body: {
				access_token: "new-access",
				refresh_token: "new-refresh",
				expires_in: 3600,
			},
		}));
		const fn = createOidcTokenRefreshFn(NO_ID_TOKEN_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		const tokens = await fn("refresh-old");

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://auth.example.com/token");
		const body = (init as RequestInit).body as URLSearchParams;
		expect(body.get("grant_type")).toBe("refresh_token");
		expect(body.get("refresh_token")).toBe("refresh-old");
		expect(body.get("client_id")).toBe("client-xyz");

		expect(tokens.accessToken).toBe("new-access");
		expect(tokens.refreshToken).toBe("new-refresh");
		expect(tokens.expiry).toBeInstanceOf(Date);
		const stored = JSON.parse(localStorage.getItem("crust:session") ?? "{}");
		expect(stored.accessToken).toBe("new-access");
		expect(stored.refreshToken).toBe("new-refresh");
	});

	it("carries the old refresh token forward when the OP doesn't rotate", async () => {
		saveSession(NO_ID_TOKEN_SESSION);
		stubRefreshEndpoint(async () => ({
			status: 200,
			body: { access_token: "new-access" },
		}));
		const fn = createOidcTokenRefreshFn(NO_ID_TOKEN_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		const tokens = await fn("refresh-old");

		// Returned to the SDK (which would otherwise unset it) AND persisted.
		expect(tokens.refreshToken).toBe("refresh-old");
		const stored = JSON.parse(localStorage.getItem("crust:session") ?? "{}");
		expect(stored.accessToken).toBe("new-access");
		expect(stored.refreshToken).toBe("refresh-old");
	});

	it("throws TokenRefreshLogoutError on invalid_grant so the SDK ends the session", async () => {
		stubRefreshEndpoint(async () => ({
			status: 400,
			body: { error: "invalid_grant" },
		}));
		const fn = createOidcTokenRefreshFn(NO_ID_TOKEN_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await expect(fn("refresh-old")).rejects.toThrow(
			"OIDC refresh was rejected by the server (invalid_grant)",
		);
	});

	it("throws TokenRefreshLogoutError on invalid_client (registration revoked)", async () => {
		stubRefreshEndpoint(async () => ({
			status: 401,
			body: { error: "invalid_client" },
		}));
		const fn = createOidcTokenRefreshFn(NO_ID_TOKEN_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await expect(fn("refresh-old")).rejects.toThrow(
			"OIDC refresh was rejected by the server (invalid_client)",
		);
	});

	it("treats other 4xx OAuth errors as transient, not logout", async () => {
		// invalid_request / temporarily_unavailable must not end the session.
		stubRefreshEndpoint(async () => ({
			status: 400,
			body: { error: "invalid_request" },
		}));
		const fn = createOidcTokenRefreshFn(NO_ID_TOKEN_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await expect(fn("refresh-old")).rejects.toThrow(
			"Token refresh failed with status 400 (invalid_request)",
		);
	});

	it("treats an unparseable 400 body as transient, not logout", async () => {
		vi.stubGlobal("fetch", async () => ({
			ok: false,
			status: 400,
			json: async () => {
				throw new SyntaxError("not json");
			},
		}));
		const fn = createOidcTokenRefreshFn(NO_ID_TOKEN_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await expect(fn("refresh-old")).rejects.toThrow(
			"Token refresh failed with status 400",
		);
	});

	it("treats a 5xx as transient (plain error, SDK retries)", async () => {
		stubRefreshEndpoint(async () => ({ status: 503, body: {} }));
		const fn = createOidcTokenRefreshFn(NO_ID_TOKEN_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await expect(fn("refresh-old")).rejects.toThrow(
			"Token refresh failed with status 503",
		);
	});

	it("throws on a malformed refresh response", async () => {
		stubRefreshEndpoint(async () => ({
			status: 200,
			body: { token_type: "Bearer" }, // no access_token
		}));
		const fn = createOidcTokenRefreshFn(NO_ID_TOKEN_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		await expect(fn("refresh-old")).rejects.toThrow(
			"Token refresh response was malformed",
		);
	});

	it("does not persist into a password session that replaced the OIDC one", async () => {
		saveSession(PASSWORD_SESSION);
		stubRefreshEndpoint(async () => ({
			status: 200,
			body: { access_token: "new-access", refresh_token: "new-refresh" },
		}));
		const fn = createOidcTokenRefreshFn(NO_ID_TOKEN_SESSION);
		if (!fn) throw new Error("expected a refresh function");

		// The refresh itself succeeds (in-memory client keeps working)...
		await fn("refresh-old");
		// ...but the replacement session in storage is untouched.
		const stored = JSON.parse(localStorage.getItem("crust:session") ?? "{}");
		expect(stored.accessToken).toBe("access-old");
		expect(stored.refreshToken).toBeUndefined();
	});
});
