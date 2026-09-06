import type { ValidatedAuthMetadata } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requiredAt } from "../../test/assertions";

// The module under test talks to matrix-js-sdk at two places: createClient
// (probe + metadata refetch + whoami) and the OAuth2 class (URL generation +
// code exchange); dynamic registration is the module's own fetch (so the
// OP's error_description survives, issue #486) and is stubbed at the fetch
// boundary. Everything else (signin state, URL guards, error curation,
// result mapping) runs for real.
const createClientMock = vi.hoisted(() => vi.fn());
const generateUrlMock = vi.hoisted(() => vi.fn());
const completeGrantMock = vi.hoisted(() => vi.fn());
const oauth2Instances = vi.hoisted(() => ({
	contexts: [] as Array<Record<string, unknown>>,
}));
vi.mock("matrix-js-sdk", () => ({
	createClient: (...args: unknown[]) => createClientMock(...args),
	OAuth2: class FakeOAuth2 {
		readonly context: Record<string, unknown>;
		constructor(
			public metadata: unknown,
			context: Record<string, unknown>,
		) {
			this.context = { codeVerifier: "sdk-generated-verifier", ...context };
			oauth2Instances.contexts.push(this.context);
		}
		generateAuthorizationCodeGrantUrl = generateUrlMock;
		completeAuthorizationCodeGrant = completeGrantMock;
	},
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
} as ValidatedAuthMetadata;

const REGISTRATIONS_KEY = "crust:oidc-client-registrations";
const SIGNIN_STATE_KEY = "crust:oidc-signin-state";

/** The signin state a real startOidcLogin would have stored. */
const STORED_SIGNIN = {
	state: "state-123",
	codeVerifier: "sdk-generated-verifier",
	homeserverUrl: "https://matrix.example.com",
	issuer: "https://auth.example.com/",
	clientId: "client-xyz",
};

function seedSigninState(overrides?: Partial<typeof STORED_SIGNIN>): void {
	sessionStorage.setItem(
		SIGNIN_STATE_KEY,
		JSON.stringify({ ...STORED_SIGNIN, ...overrides }),
	);
}

/** Stub global fetch for the registration endpoint. `body: undefined`
 *  models a non-JSON body: `json()` rejects the way a real Response's
 *  would for an HTML error page. */
function stubRegistration(
	status: number,
	body?: unknown,
): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async () => ({
		// Real Response.ok is 2xx only - a 3xx must read as not-ok here too.
		ok: status >= 200 && status < 300,
		status,
		json: async () => {
			if (body === undefined) {
				throw new SyntaxError("Unexpected token '<'");
			}
			return body;
		},
	}));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	oauth2Instances.contexts.length = 0;
	// Default: the metadata refetch at callback time succeeds.
	createClientMock.mockReturnValue({
		getAuthMetadata: vi.fn(async () => METADATA),
	});
	generateUrlMock.mockImplementation(
		async (state: string) =>
			`https://auth.example.com/authorize?response_type=code&client_id=client-xyz&state=${state}`,
	);
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
	it("registers on first login, caches the client_id, and returns the authorization URL", async () => {
		const fetchMock = stubRegistration(201, { client_id: "client-xyz" });

		const url = await startOidcLogin(METADATA, "https://matrix.example.com");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [
			URL,
			{ body: string },
		];
		expect(String(endpoint)).toBe("https://auth.example.com/register");
		expect(JSON.parse(init.body)).toMatchObject({
			client_name: "Crust",
			client_uri: `${window.location.origin}/`,
			application_type: "web",
			redirect_uris: [`${window.location.origin}/login/callback`],
			token_endpoint_auth_method: "none",
		});
		expect(getCachedClientId("https://auth.example.com/")).toBe("client-xyz");

		// The URL comes from the SDK's OAuth2 instance, called with query
		// response mode and our state.
		expect(generateUrlMock).toHaveBeenCalledTimes(1);
		const [stateArg, responseMode] = requiredAt(
			generateUrlMock.mock.calls,
			0,
			"generate URL call",
		);
		expect(responseMode).toBe("query");
		expect(url).toContain(`state=${stateArg}`);

		// The signin state stored for the callback carries the SDK-generated
		// PKCE verifier and matches the URL's state.
		const stored = JSON.parse(
			sessionStorage.getItem(SIGNIN_STATE_KEY) ?? "null",
		);
		expect(stored).toMatchObject({
			homeserverUrl: "https://matrix.example.com",
			issuer: "https://auth.example.com/",
			clientId: "client-xyz",
			codeVerifier: "sdk-generated-verifier",
		});
		expect(stored.state).toBe(stateArg);
	});

	it("reuses the cached registration instead of re-registering", async () => {
		localStorage.setItem(
			REGISTRATIONS_KEY,
			JSON.stringify({ "https://auth.example.com/": "cached-client" }),
		);

		const fetchMock = stubRegistration(201, { client_id: "unused" });
		await startOidcLogin(METADATA, "https://matrix.example.com");

		expect(fetchMock).not.toHaveBeenCalled();
		expect(
			requiredAt(oauth2Instances.contexts, 0, "OAuth context").clientId,
		).toBe("cached-client");
	});

	it("generates a fresh state per login", async () => {
		localStorage.setItem(
			REGISTRATIONS_KEY,
			JSON.stringify({ "https://auth.example.com/": "cached-client" }),
		);

		await startOidcLogin(METADATA, "https://matrix.example.com");
		const first = sessionStorage.getItem(SIGNIN_STATE_KEY);
		await startOidcLogin(METADATA, "https://matrix.example.com");
		const second = sessionStorage.getItem(SIGNIN_STATE_KEY);

		expect(first).not.toBe(second);
	});

	it("surfaces the OP's rejection reason without caching or storing state", async () => {
		// The generic "Dynamic registration failed" hid "Client URI must be
		// HTTPS." for days (issue #486); the OP's reason must reach the user.
		stubRegistration(400, {
			error: "invalid_client_metadata",
			error_description: "Client URI must be HTTPS.",
		});

		await expect(
			startOidcLogin(METADATA, "https://matrix.example.com"),
		).rejects.toThrow(
			"The login service rejected this app's registration: Client URI must be HTTPS.",
		);
		expect(getCachedClientId("https://auth.example.com/")).toBeNull();
		expect(sessionStorage.getItem(SIGNIN_STATE_KEY)).toBeNull();
	});

	it("falls back to a generic message when the error body is not JSON", async () => {
		// A reverse proxy answering with an HTML 502 page must not surface
		// as a raw SyntaxError - the opaque-error class #486 exists to kill.
		stubRegistration(502);

		await expect(
			startOidcLogin(METADATA, "https://matrix.example.com"),
		).rejects.toThrow("Dynamic registration failed (HTTP 502).");
	});

	it("falls back to a generic message when the error body has no description", async () => {
		stubRegistration(500, { error: "server_error" });

		await expect(
			startOidcLogin(METADATA, "https://matrix.example.com"),
		).rejects.toThrow("Dynamic registration failed (HTTP 500).");
	});

	it("refuses a non-web registration endpoint before fetching", async () => {
		// Homeserver-supplied metadata; in the desktop shell the CSP admits
		// ipc:, so a malicious OP must not steer the registration POST there.
		const fetchMock = stubRegistration(201, { client_id: "unused" });
		const meta = {
			...METADATA,
			registration_endpoint: "ipc://localhost/register",
		} as typeof METADATA;

		await expect(
			startOidcLogin(meta, "https://matrix.example.com"),
		).rejects.toThrow("The login service metadata is invalid.");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("curates an outright network failure without caching or storing state", async () => {
		// fetch rejecting (offline, DNS) must not leak a raw TypeError.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("Failed to fetch");
			}),
		);

		await expect(
			startOidcLogin(METADATA, "https://matrix.example.com"),
		).rejects.toThrow(
			"Could not reach the login service to register this app. Check your connection and try again.",
		);
		expect(getCachedClientId("https://auth.example.com/")).toBeNull();
		expect(sessionStorage.getItem(SIGNIN_STATE_KEY)).toBeNull();
	});

	it("rejects a non-JSON success body as an invalid response", async () => {
		stubRegistration(201);

		await expect(
			startOidcLogin(METADATA, "https://matrix.example.com"),
		).rejects.toThrow(
			"The login service returned an invalid registration response.",
		);
	});

	it("rejects a success response without a client_id", async () => {
		stubRegistration(201, { unexpected: true });

		await expect(
			startOidcLogin(METADATA, "https://matrix.example.com"),
		).rejects.toThrow(
			"The login service returned an invalid registration response.",
		);
		expect(getCachedClientId("https://auth.example.com/")).toBeNull();
	});

	it("rejects a non-web authorization URL (javascript: would execute in our origin)", async () => {
		localStorage.setItem(
			REGISTRATIONS_KEY,
			JSON.stringify({ "https://auth.example.com/": "cached-client" }),
		);
		generateUrlMock.mockResolvedValue("javascript:alert(document.domain)");

		await expect(
			startOidcLogin(METADATA, "https://matrix.example.com"),
		).rejects.toThrow("The homeserver returned an invalid login URL.");
	});

	it("rejects an unparseable authorization URL", async () => {
		localStorage.setItem(
			REGISTRATIONS_KEY,
			JSON.stringify({ "https://auth.example.com/": "cached-client" }),
		);
		generateUrlMock.mockResolvedValue("not a url");

		await expect(
			startOidcLogin(METADATA, "https://matrix.example.com"),
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
	function stubGrantAndWhoami(whoami: {
		user_id: string;
		device_id?: string;
	}): void {
		completeGrantMock.mockResolvedValue({
			access_token: "access-123",
			token_type: "Bearer",
			refresh_token: "refresh-abc",
			expires_in: 3600,
		});
		createClientMock.mockImplementation((opts: Record<string, unknown>) =>
			opts.accessToken
				? { whoami: vi.fn(async () => whoami) }
				: { getAuthMetadata: vi.fn(async () => METADATA) },
		);
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

	it("exchanges the code via the SDK and maps grant + whoami into a session payload", async () => {
		seedSigninState();
		stubGrantAndWhoami({
			user_id: "@alice:example.com",
			device_id: "DEVICE42",
		});

		const result = await completeOidcLogin("?code=abc&state=state-123");

		// The OAuth2 context was rebuilt from the stored signin state.
		const ctx = oauth2Instances.contexts[0];
		expect(ctx).toMatchObject({
			clientId: "client-xyz",
			codeVerifier: "sdk-generated-verifier",
			redirectUri: `${window.location.origin}/login/callback`,
		});
		expect(completeGrantMock).toHaveBeenCalledWith("abc");

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

	it("omits refreshToken when the provider does not issue one", async () => {
		seedSigninState();
		completeGrantMock.mockResolvedValue({
			access_token: "access-123",
			token_type: "Bearer",
		});
		createClientMock.mockImplementation((opts: Record<string, unknown>) =>
			opts.accessToken
				? {
						whoami: vi.fn(async () => ({
							user_id: "@alice:example.com",
							device_id: "DEVICE42",
						})),
					}
				: { getAuthMetadata: vi.fn(async () => METADATA) },
		);

		const result = await completeOidcLogin("?code=abc&state=state-123");

		expect(result).not.toHaveProperty("refreshToken");
	});

	it("omits refreshToken when the provider returns an empty one", async () => {
		seedSigninState();
		completeGrantMock.mockResolvedValue({
			access_token: "access-123",
			refresh_token: "",
			token_type: "Bearer",
		});
		createClientMock.mockImplementation((opts: Record<string, unknown>) =>
			opts.accessToken
				? {
						whoami: vi.fn(async () => ({
							user_id: "@alice:example.com",
							device_id: "DEVICE42",
						})),
					}
				: { getAuthMetadata: vi.fn(async () => METADATA) },
		);

		const result = await completeOidcLogin("?code=abc&state=state-123");

		expect(result).not.toHaveProperty("refreshToken");
	});

	it("swaps platform jargon from the exchange leg for the curated fallback", async () => {
		seedSigninState();
		completeGrantMock.mockRejectedValue(new TypeError("Failed to fetch"));

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow(
			"Could not complete the login with the homeserver. Try again.",
		);
	});

	it("keeps human-written messages from the exchange leg", async () => {
		seedSigninState();
		completeGrantMock.mockRejectedValue(
			new Error("The authorization code has expired."),
		);

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow("The authorization code has expired.");
	});

	it("curates a metadata-refetch failure at callback time", async () => {
		seedSigninState();
		createClientMock.mockReturnValue({
			getAuthMetadata: vi.fn(async () => {
				throw new TypeError("Failed to fetch");
			}),
		});

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow(
			"Could not complete the login with the homeserver. Try again.",
		);
	});

	it("swaps platform jargon from the whoami leg for the curated fallback", async () => {
		seedSigninState();
		completeGrantMock.mockResolvedValue({
			access_token: "access-123",
			token_type: "Bearer",
		});
		createClientMock.mockImplementation((opts: Record<string, unknown>) =>
			opts.accessToken
				? {
						whoami: vi.fn(async () => {
							throw new TypeError("Failed to fetch");
						}),
					}
				: { getAuthMetadata: vi.fn(async () => METADATA) },
		);

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow(
			"The homeserver could not confirm the new session. Try logging in again.",
		);
	});

	it("throws when the server assigns no device ID", async () => {
		seedSigninState();
		stubGrantAndWhoami({ user_id: "@alice:example.com" });

		await expect(
			completeOidcLogin("?code=abc&state=state-123"),
		).rejects.toThrow(
			"The homeserver did not assign a device ID to this session.",
		);
	});
});
