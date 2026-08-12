import type { OidcClientConfig } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module under test talks to matrix-js-sdk at exactly two functions
// (createClient for probe/whoami, registerOidcClient for dynamic
// registration); mock that boundary so discovery/registration behavior is
// scripted per test without a network. decodeIdToken and generateScope run
// for real (pure functions).
const createClientMock = vi.fn();
const registerOidcClientMock = vi.fn();
vi.mock("matrix-js-sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("matrix-js-sdk")>();
	return {
		...actual,
		createClient: (...args: unknown[]) => createClientMock(...args),
		registerOidcClient: (...args: unknown[]) => registerOidcClientMock(...args),
	};
});

import {
	completeOidcLogin,
	getCachedClientId,
	oidcRedirectUri,
	probeDelegatedAuth,
	startOidcLogin,
	stashOidcReturnTo,
	takeOidcReturnTo,
} from "./oidc";

const METADATA = {
	issuer: "https://auth.example.com/",
	authorization_endpoint: "https://auth.example.com/authorize",
	token_endpoint: "https://auth.example.com/token",
	revocation_endpoint: "https://auth.example.com/revoke",
	registration_endpoint: "https://auth.example.com/register",
	response_types_supported: ["code"],
	grant_types_supported: ["authorization_code", "refresh_token"],
	code_challenge_methods_supported: ["S256"],
} as OidcClientConfig;

const REGISTRATIONS_KEY = "crust:oidc-client-registrations";
const SIGNIN_STATE_KEY = "crust:oidc-signin-state";

/** A syntactically valid (unsigned) JWT for decodeIdToken to parse. */
function fakeIdToken(claims: Record<string, unknown>): string {
	const segment = (value: Record<string, unknown>): string =>
		btoa(JSON.stringify(value))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	return `${segment({ alg: "RS256", typ: "JWT" })}.${segment(claims)}.sig`;
}

/** The signin state a real startOidcLogin would have stored. */
const STORED_SIGNIN = {
	state: "state-123",
	codeVerifier: "verifier-abc",
	nonce: "nonce-xyz",
	homeserverUrl: "https://matrix.example.com",
	issuer: "https://auth.example.com/",
	clientId: "client-xyz",
	tokenEndpoint: "https://auth.example.com/token",
};

function seedSigninState(overrides?: Partial<typeof STORED_SIGNIN>): void {
	sessionStorage.setItem(
		SIGNIN_STATE_KEY,
		JSON.stringify({ ...STORED_SIGNIN, ...overrides }),
	);
}

/** Stub the token endpoint via global fetch. */
function stubTokenEndpoint(
	handler: (init: RequestInit) => Promise<{
		status: number;
		body: unknown;
	}>,
): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
		const { status, body } = await handler(init);
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
		} as Response;
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});
afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
	sessionStorage.clear();
});

describe("probeDelegatedAuth", () => {
	it("returns the validated metadata when the server delegates auth", async () => {
		const getAuthMetadata = vi.fn(async () => METADATA);
		createClientMock.mockReturnValue({ getAuthMetadata });

		await expect(
			probeDelegatedAuth("https://matrix.example.com"),
		).resolves.toBe(METADATA);
		expect(createClientMock).toHaveBeenCalledWith({
			baseUrl: "https://matrix.example.com",
		});
	});

	it("returns null when the server has no delegated auth", async () => {
		const getAuthMetadata = vi.fn(async () => {
			throw new Error("404");
		});
		createClientMock.mockReturnValue({ getAuthMetadata });

		await expect(
			probeDelegatedAuth("https://matrix.example.com"),
		).resolves.toBeNull();
	});
});

describe("oidcRedirectUri", () => {
	it("is the app origin plus the callback route", () => {
		expect(oidcRedirectUri()).toBe(`${window.location.origin}/login/callback`);
	});
});

describe("client registration cache", () => {
	it("returns null for an unknown issuer", () => {
		expect(getCachedClientId("https://auth.example.com/")).toBeNull();
	});

	it("returns null for a corrupt cache", () => {
		localStorage.setItem(REGISTRATIONS_KEY, "not json {");
		expect(getCachedClientId("https://auth.example.com/")).toBeNull();
	});

	it("ignores non-string cache entries", () => {
		localStorage.setItem(
			REGISTRATIONS_KEY,
			JSON.stringify({ "https://auth.example.com/": 42 }),
		);
		expect(getCachedClientId("https://auth.example.com/")).toBeNull();
	});
});

describe("startOidcLogin", () => {
	it("registers on first login, caches the client_id, and builds the authorization URL", async () => {
		registerOidcClientMock.mockResolvedValue("client-xyz");

		const url = await startOidcLogin(METADATA, "https://matrix.example.com");

		expect(registerOidcClientMock).toHaveBeenCalledTimes(1);
		const [metadataArg, registrationArg] = registerOidcClientMock.mock.calls[0];
		expect(metadataArg).toBe(METADATA);
		expect(registrationArg).toMatchObject({
			clientName: "Crust",
			clientUri: `${window.location.origin}/`,
			applicationType: "web",
			redirectUris: [`${window.location.origin}/login/callback`],
		});
		expect(getCachedClientId("https://auth.example.com/")).toBe("client-xyz");

		// The URL targets the metadata's authorization endpoint with the full
		// authorization-code + PKCE parameter set.
		const parsed = new URL(url);
		expect(parsed.origin + parsed.pathname).toBe(
			"https://auth.example.com/authorize",
		);
		expect(parsed.searchParams.get("response_type")).toBe("code");
		expect(parsed.searchParams.get("client_id")).toBe("client-xyz");
		expect(parsed.searchParams.get("redirect_uri")).toBe(
			`${window.location.origin}/login/callback`,
		);
		expect(parsed.searchParams.get("scope")).toContain("openid");
		expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
		expect(parsed.searchParams.get("code_challenge")).toMatch(
			/^[A-Za-z0-9_-]{43}$/,
		);

		// The signin state is stored for the callback, and the URL's state and
		// nonce match it exactly.
		const stored = JSON.parse(
			sessionStorage.getItem(SIGNIN_STATE_KEY) ?? "null",
		);
		expect(stored).toMatchObject({
			homeserverUrl: "https://matrix.example.com",
			issuer: "https://auth.example.com/",
			clientId: "client-xyz",
			tokenEndpoint: "https://auth.example.com/token",
		});
		expect(parsed.searchParams.get("state")).toBe(stored.state);
		expect(parsed.searchParams.get("nonce")).toBe(stored.nonce);
		expect(stored.codeVerifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
	});

	it("reuses the cached registration instead of re-registering", async () => {
		localStorage.setItem(
			REGISTRATIONS_KEY,
			JSON.stringify({ "https://auth.example.com/": "cached-client" }),
		);

		const url = await startOidcLogin(METADATA, "https://matrix.example.com");

		expect(registerOidcClientMock).not.toHaveBeenCalled();
		expect(new URL(url).searchParams.get("client_id")).toBe("cached-client");
	});

	it("generates fresh state, nonce, and verifier per login", async () => {
		localStorage.setItem(
			REGISTRATIONS_KEY,
			JSON.stringify({ "https://auth.example.com/": "cached-client" }),
		);

		const first = await startOidcLogin(METADATA, "https://matrix.example.com");
		const firstState = sessionStorage.getItem(SIGNIN_STATE_KEY);
		const second = await startOidcLogin(METADATA, "https://matrix.example.com");
		const secondState = sessionStorage.getItem(SIGNIN_STATE_KEY);

		expect(new URL(first).searchParams.get("state")).not.toBe(
			new URL(second).searchParams.get("state"),
		);
		expect(firstState).not.toBe(secondState);
	});

	it("propagates a registration failure without caching or storing state", async () => {
		registerOidcClientMock.mockRejectedValue(
			new Error("Dynamic registration failed"),
		);

		await expect(
			startOidcLogin(METADATA, "https://matrix.example.com"),
		).rejects.toThrow("Dynamic registration failed");
		expect(getCachedClientId("https://auth.example.com/")).toBeNull();
		expect(sessionStorage.getItem(SIGNIN_STATE_KEY)).toBeNull();
	});

	it("rejects a non-web authorization endpoint (javascript: would execute in our origin)", async () => {
		localStorage.setItem(
			REGISTRATIONS_KEY,
			JSON.stringify({ "https://auth.example.com/": "cached-client" }),
		);

		await expect(
			startOidcLogin(
				{ ...METADATA, authorization_endpoint: "javascript:alert(1)" },
				"https://matrix.example.com",
			),
		).rejects.toThrow("The homeserver returned an invalid login URL.");
	});

	it("rejects an unparseable authorization endpoint", async () => {
		localStorage.setItem(
			REGISTRATIONS_KEY,
			JSON.stringify({ "https://auth.example.com/": "cached-client" }),
		);

		await expect(
			startOidcLogin(
				{ ...METADATA, authorization_endpoint: "not a url" },
				"https://matrix.example.com",
			),
		).rejects.toThrow("The homeserver returned an invalid login URL.");
	});
});

describe("returnTo stash", () => {
	it("round-trips the stashed path exactly once", () => {
		stashOidcReturnTo("/home/!room:example.com");
		expect(takeOidcReturnTo()).toBe("/home/!room:example.com");
		expect(takeOidcReturnTo()).toBeNull();
	});

	it("returns null when nothing was stashed", () => {
		expect(takeOidcReturnTo()).toBeNull();
	});
});

describe("completeOidcLogin", () => {
	function stubWhoami(whoami: { user_id: string; device_id?: string }): void {
		createClientMock.mockReturnValue({
			whoami: vi.fn(async () => whoami),
		});
	}

	it("throws the OP's error_description when the redirect carries an error", async () => {
		await expect(
			completeOidcLogin("?error=access_denied&error_description=User+refused"),
		).rejects.toThrow("Login failed: User refused (access_denied).");
	});

	it("throws a generic message for an OP error without description", async () => {
		await expect(completeOidcLogin("?error=server_error")).rejects.toThrow(
			"Login failed (server_error).",
		);
	});

	it("throws when the callback lacks code or state", async () => {
		await expect(completeOidcLogin("?code=abc")).rejects.toThrow(
			"This login link is incomplete.",
		);
		await expect(completeOidcLogin("?state=xyz")).rejects.toThrow(
			"This login link is incomplete.",
		);
		await expect(completeOidcLogin("")).rejects.toThrow(
			"This login link is incomplete.",
		);
	});

	it("throws when no signin state was stored (wrong tab / expired)", async () => {
		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow(
			"This login session has expired or was started elsewhere.",
		);
	});

	it("throws when the returned state doesn't match the stored state (login CSRF)", async () => {
		seedSigninState();
		await expect(completeOidcLogin("?code=abc&state=WRONG")).rejects.toThrow(
			"This login session has expired or was started elsewhere.",
		);
	});

	it("exchanges the code with PKCE and maps the response into a session payload (no id_token)", async () => {
		seedSigninState();
		const fetchMock = stubTokenEndpoint(async () => ({
			status: 200,
			body: {
				access_token: "access-123",
				token_type: "Bearer",
				refresh_token: "refresh-abc",
				expires_in: 3600,
				scope: "urn:matrix:client:api:*",
			},
		}));
		stubWhoami({ user_id: "@alice:example.com", device_id: "DEVICE42" });

		const result = await completeOidcLogin("?code=abc&state=state-123");

		// The exchange POSTs the grant to the stored token endpoint with the
		// PKCE verifier and registered client.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://auth.example.com/token");
		const body = (init as RequestInit).body as URLSearchParams;
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code")).toBe("abc");
		expect(body.get("code_verifier")).toBe("verifier-abc");
		expect(body.get("client_id")).toBe("client-xyz");
		expect(body.get("redirect_uri")).toBe(
			`${window.location.origin}/login/callback`,
		);

		expect(createClientMock).toHaveBeenCalledWith({
			baseUrl: "https://matrix.example.com",
			accessToken: "access-123",
		});
		expect(result).toEqual({
			accessToken: "access-123",
			refreshToken: "refresh-abc",
			userId: "@alice:example.com",
			deviceId: "DEVICE42",
			homeserverUrl: "https://matrix.example.com",
			oidc: {
				issuer: "https://auth.example.com/",
				clientId: "client-xyz",
				idToken: undefined,
				tokenEndpoint: "https://auth.example.com/token",
			},
		});

		// The signin state is single-use: a replayed callback fails closed.
		expect(sessionStorage.getItem(SIGNIN_STATE_KEY)).toBeNull();
		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow(
			"This login session has expired or was started elsewhere.",
		);
	});

	it("accepts and validates an id_token when the OP issues one", async () => {
		seedSigninState();
		stubTokenEndpoint(async () => ({
			status: 200,
			body: {
				access_token: "access-123",
				token_type: "Bearer",
				id_token: fakeIdToken({
					iss: "https://auth.example.com/",
					aud: "client-xyz",
					nonce: "nonce-xyz",
					exp: Math.floor(Date.now() / 1000) + 600,
				}),
			},
		}));
		stubWhoami({ user_id: "@alice:example.com", device_id: "DEVICE42" });

		const result = await completeOidcLogin("?code=abc&state=state-123");
		expect(result.oidc.idToken).toBeTypeOf("string");
	});

	it("rejects an id_token with a mismatched nonce", async () => {
		seedSigninState();
		stubTokenEndpoint(async () => ({
			status: 200,
			body: {
				access_token: "access-123",
				token_type: "Bearer",
				id_token: fakeIdToken({
					iss: "https://auth.example.com/",
					aud: "client-xyz",
					nonce: "WRONG",
					exp: Math.floor(Date.now() / 1000) + 600,
				}),
			},
		}));

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow("The homeserver's login response failed validation.");
	});

	it("rejects an id_token with no exp claim", async () => {
		seedSigninState();
		stubTokenEndpoint(async () => ({
			status: 200,
			body: {
				access_token: "access-123",
				token_type: "Bearer",
				id_token: fakeIdToken({
					iss: "https://auth.example.com/",
					aud: "client-xyz",
					nonce: "nonce-xyz",
					// exp deliberately absent: OIDC Core requires it.
				}),
			},
		}));

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow("The homeserver's login response failed validation.");
	});

	it("rejects an expired id_token", async () => {
		seedSigninState();
		stubTokenEndpoint(async () => ({
			status: 200,
			body: {
				access_token: "access-123",
				token_type: "Bearer",
				id_token: fakeIdToken({
					iss: "https://auth.example.com/",
					aud: "client-xyz",
					nonce: "nonce-xyz",
					exp: Math.floor(Date.now() / 1000) - 60,
				}),
			},
		}));

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow("The homeserver's login response failed validation.");
	});

	it("rejects a malformed id_token", async () => {
		seedSigninState();
		stubTokenEndpoint(async () => ({
			status: 200,
			body: {
				access_token: "access-123",
				token_type: "Bearer",
				id_token: "not-a-jwt",
			},
		}));

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow("The homeserver's login response failed validation.");
	});

	it("surfaces the OP's error_description from a rejected exchange", async () => {
		seedSigninState();
		stubTokenEndpoint(async () => ({
			status: 400,
			body: {
				error: "invalid_grant",
				error_description: "The authorization code has expired.",
			},
		}));

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow("Login failed: The authorization code has expired.");
	});

	it("falls back to a status message when the error body isn't JSON", async () => {
		seedSigninState();
		stubTokenEndpoint(async () => ({ status: 500, body: "not json" }));

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow("The homeserver rejected the login (500). Try again.");
	});

	it("swaps network jargon from the exchange leg for the curated fallback", async () => {
		seedSigninState();
		vi.stubGlobal("fetch", async () => {
			throw new TypeError("Failed to fetch");
		});

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow(
			"Could not complete the login with the homeserver. Try again.",
		);
	});

	it("rejects a malformed success body", async () => {
		seedSigninState();
		stubTokenEndpoint(async () => ({
			status: 200,
			body: { token_type: "Bearer" }, // no access_token
		}));

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow("The homeserver's login response was malformed.");
	});

	it("rejects a non-Bearer token_type", async () => {
		seedSigninState();
		stubTokenEndpoint(async () => ({
			status: 200,
			body: { access_token: "access-123", token_type: "MAC" },
		}));

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow("The homeserver's login response was malformed.");
	});

	it("accepts a case-insensitive bearer token_type", async () => {
		seedSigninState();
		stubTokenEndpoint(async () => ({
			status: 200,
			body: { access_token: "access-123", token_type: "bearer" },
		}));
		stubWhoami({ user_id: "@alice:example.com", device_id: "DEVICE42" });

		const result = await completeOidcLogin("?code=abc&state=state-123");
		expect(result.accessToken).toBe("access-123");
	});

	it("curates a 200 with a non-JSON body instead of leaking SyntaxError jargon", async () => {
		seedSigninState();
		vi.stubGlobal("fetch", async () => ({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError("Unexpected token < in JSON at position 0");
			},
		}));

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow("The homeserver's login response was malformed.");
	});

	it("swaps platform jargon from the whoami leg for the curated fallback", async () => {
		seedSigninState();
		stubTokenEndpoint(async () => ({
			status: 200,
			body: { access_token: "access-123", token_type: "Bearer" },
		}));
		createClientMock.mockReturnValue({
			whoami: vi.fn(async () => {
				throw new TypeError("Failed to fetch");
			}),
		});

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow(
			"The homeserver could not confirm the new session. Try logging in again.",
		);
	});

	it("throws when the server assigns no device ID", async () => {
		seedSigninState();
		stubTokenEndpoint(async () => ({
			status: 200,
			body: { access_token: "access-123", token_type: "Bearer" },
		}));
		stubWhoami({ user_id: "@alice:example.com" });

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow(
			"The homeserver did not assign a device ID to this session.",
		);
	});
});
