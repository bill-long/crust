import type { OidcClientConfig } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module under test talks to matrix-js-sdk at exactly four functions;
// mock that boundary so discovery/registration/exchange behavior is
// scripted per test without a network.
const createClientMock = vi.fn();
const completeAuthorizationCodeGrantMock = vi.fn();
const generateOidcAuthorizationUrlMock = vi.fn();
const registerOidcClientMock = vi.fn();
vi.mock("matrix-js-sdk", () => ({
	createClient: (...args: unknown[]) => createClientMock(...args),
	completeAuthorizationCodeGrant: (...args: unknown[]) =>
		completeAuthorizationCodeGrantMock(...args),
	generateOidcAuthorizationUrl: (...args: unknown[]) =>
		generateOidcAuthorizationUrlMock(...args),
	registerOidcClient: (...args: unknown[]) => registerOidcClientMock(...args),
}));

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

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});
afterEach(() => {
	vi.clearAllMocks();
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
		// A legacy-only homeserver 404s /auth_metadata and /auth_issuer; the
		// SDK surfaces that as a rejection.
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
		generateOidcAuthorizationUrlMock.mockResolvedValue(
			"https://auth.example.com/authorize?...",
		);

		const url = await startOidcLogin(METADATA, "https://matrix.example.com");

		expect(url).toBe("https://auth.example.com/authorize?...");
		expect(registerOidcClientMock).toHaveBeenCalledTimes(1);
		const [metadataArg, registrationArg] = registerOidcClientMock.mock.calls[0];
		expect(metadataArg).toBe(METADATA);
		expect(registrationArg).toEqual({
			clientName: "Crust",
			clientUri: `${window.location.origin}/`,
			applicationType: "web",
			redirectUris: [`${window.location.origin}/login/callback`],
		});
		// The registration is cached under the issuer.
		expect(getCachedClientId("https://auth.example.com/")).toBe("client-xyz");

		const authArgs = generateOidcAuthorizationUrlMock.mock.calls[0][0];
		expect(authArgs).toMatchObject({
			metadata: METADATA,
			clientId: "client-xyz",
			homeserverUrl: "https://matrix.example.com",
			redirectUri: `${window.location.origin}/login/callback`,
		});
		// 128 bits of entropy base64url-encoded: 22 chars, URL-safe alphabet.
		expect(authArgs.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
	});

	it("reuses the cached registration instead of re-registering", async () => {
		localStorage.setItem(
			REGISTRATIONS_KEY,
			JSON.stringify({ "https://auth.example.com/": "cached-client" }),
		);
		generateOidcAuthorizationUrlMock.mockResolvedValue("https://auth/url");

		await startOidcLogin(METADATA, "https://matrix.example.com");

		expect(registerOidcClientMock).not.toHaveBeenCalled();
		expect(generateOidcAuthorizationUrlMock.mock.calls[0][0].clientId).toBe(
			"cached-client",
		);
	});

	it("generates a fresh nonce per login", async () => {
		localStorage.setItem(
			REGISTRATIONS_KEY,
			JSON.stringify({ "https://auth.example.com/": "cached-client" }),
		);
		generateOidcAuthorizationUrlMock.mockResolvedValue("https://auth/url");

		await startOidcLogin(METADATA, "https://matrix.example.com");
		await startOidcLogin(METADATA, "https://matrix.example.com");

		const [first, second] = generateOidcAuthorizationUrlMock.mock.calls;
		expect(first[0].nonce).not.toBe(second[0].nonce);
	});

	it("propagates a registration failure without caching", async () => {
		registerOidcClientMock.mockRejectedValue(
			new Error("Dynamic registration failed"),
		);

		await expect(
			startOidcLogin(METADATA, "https://matrix.example.com"),
		).rejects.toThrow("Dynamic registration failed");
		expect(getCachedClientId("https://auth.example.com/")).toBeNull();
	});

	it("rejects a non-web authorization URL (javascript: would execute in our origin)", async () => {
		// The SDK emits the homeserver-supplied authorization_endpoint
		// verbatim; a malicious homeserver must not turn the redirect into
		// script execution via location.assign.
		localStorage.setItem(
			REGISTRATIONS_KEY,
			JSON.stringify({ "https://auth.example.com/": "cached-client" }),
		);
		generateOidcAuthorizationUrlMock.mockResolvedValue(
			"javascript:alert(document.domain)",
		);

		await expect(
			startOidcLogin(METADATA, "https://matrix.example.com"),
		).rejects.toThrow("The homeserver returned an invalid login URL.");
	});

	it("rejects an unparseable authorization URL", async () => {
		localStorage.setItem(
			REGISTRATIONS_KEY,
			JSON.stringify({ "https://auth.example.com/": "cached-client" }),
		);
		generateOidcAuthorizationUrlMock.mockResolvedValue("not a url");

		await expect(
			startOidcLogin(METADATA, "https://matrix.example.com"),
		).rejects.toThrow("The homeserver returned an invalid login URL.");
	});
});

describe("returnTo stash", () => {
	it("round-trips the stashed path exactly once", () => {
		stashOidcReturnTo("/home/!room:example.com");
		expect(takeOidcReturnTo()).toBe("/home/!room:example.com");
		// Consumed: a second read must not replay a stale target.
		expect(takeOidcReturnTo()).toBeNull();
	});

	it("returns null when nothing was stashed", () => {
		expect(takeOidcReturnTo()).toBeNull();
	});
});

describe("completeOidcLogin", () => {
	function stubGrantAndWhoami(whoami: {
		user_id: string;
		device_id?: string;
	}): void {
		completeAuthorizationCodeGrantMock.mockResolvedValue({
			oidcClientSettings: {
				issuer: "https://auth.example.com/",
				clientId: "client-xyz",
			},
			tokenResponse: {
				token_type: "Bearer",
				access_token: "access-123",
				refresh_token: "refresh-abc",
				scope: "openid",
				id_token: "header.payload.signature",
			},
			homeserverUrl: "https://matrix.example.com/",
			idTokenClaims: { sub: "@alice:example.com" },
		});
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

	it("exchanges the code and maps grant + whoami into a session payload", async () => {
		stubGrantAndWhoami({
			user_id: "@alice:example.com",
			device_id: "DEVICE42",
		});

		const result = await completeOidcLogin("?code=abc&state=xyz");

		expect(completeAuthorizationCodeGrantMock).toHaveBeenCalledWith(
			"abc",
			"xyz",
		);
		expect(createClientMock).toHaveBeenCalledWith({
			baseUrl: "https://matrix.example.com/",
			accessToken: "access-123",
		});
		expect(result).toEqual({
			accessToken: "access-123",
			refreshToken: "refresh-abc",
			userId: "@alice:example.com",
			deviceId: "DEVICE42",
			// Trailing slash stripped, matching discovery.ts's normalization.
			homeserverUrl: "https://matrix.example.com",
			oidc: {
				issuer: "https://auth.example.com/",
				clientId: "client-xyz",
				idToken: "header.payload.signature",
			},
		});
	});

	it("throws when the server assigns no device ID", async () => {
		stubGrantAndWhoami({ user_id: "@alice:example.com" });

		await expect(completeOidcLogin("?code=abc&state=xyz")).rejects.toThrow(
			"The homeserver did not assign a device ID to this session.",
		);
	});

	it("swaps platform jargon from the exchange leg for the curated fallback", async () => {
		// A network failure rejects with TypeError("Failed to fetch") -
		// meaningless in the login UI (the #421 error-quality class).
		completeAuthorizationCodeGrantMock.mockRejectedValue(
			new TypeError("Failed to fetch"),
		);

		await expect(completeOidcLogin("?code=abc&state=xyz")).rejects.toThrow(
			"Could not complete the login with the homeserver. Try again.",
		);
	});

	it("keeps human-written messages from the exchange leg", async () => {
		completeAuthorizationCodeGrantMock.mockRejectedValue(
			new Error("The authorization code has expired."),
		);

		await expect(completeOidcLogin("?code=abc&state=xyz")).rejects.toThrow(
			"The authorization code has expired.",
		);
	});

	it("swaps platform jargon from the whoami leg for the curated fallback", async () => {
		stubGrantAndWhoami({ user_id: "@alice:example.com" });
		createClientMock.mockReturnValue({
			whoami: vi.fn(async () => {
				throw new TypeError("Failed to fetch");
			}),
		});

		await expect(completeOidcLogin("?code=abc&state=xyz")).rejects.toThrow(
			"The homeserver could not confirm the new session. Try logging in again.",
		);
	});
});
