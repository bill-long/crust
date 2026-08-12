/**
 * OAuth 2.0 / OIDC (MSC3861 delegated auth) login flow.
 *
 * Split into framework-free helpers so the LoginPage / LoginCallback
 * components stay thin and everything here is unit-testable in jsdom:
 *
 *  1. {@link probeDelegatedAuth} - does this homeserver delegate auth?
 *  2. {@link startOidcLogin} - dynamic client registration (cached per
 *     issuer), then build the authorization URL with our own signin state
 *     (state + PKCE verifier + nonce in sessionStorage); the caller
 *     navigates to it.
 *  3. {@link completeOidcLogin} - verify the returned state, exchange the
 *     code at the token endpoint, then whoami for the user/device IDs.
 *
 * The authorization-code legs (URL generation, signin state, token
 * exchange) are owned here rather than delegated to the SDK's
 * generateOidcAuthorizationUrl / completeAuthorizationCodeGrant, because
 * those hard-require an `id_token` in the token response - and real-world
 * OPs exist that don't issue one (Continuwuity's built-in OAuth server,
 * verified v26.7.x). When the OP does issue an id_token it is validated
 * (iss/aud/nonce/exp); when it doesn't, identity is proven by the whoami
 * call with the freshly exchanged access token.
 */
import {
	createClient,
	decodeIdToken,
	generateScope,
	type OidcClientConfig,
	registerOidcClient,
} from "matrix-js-sdk";
import { basePrefix } from "../../app/basePath";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { safeLocalStorage } from "../../lib/persistedSignal";
import { STORAGE_KEYS } from "../../lib/storageKeys";

/**
 * Probe a homeserver for MSC3861 delegated auth. Returns validated OP
 * metadata when the server delegates authentication to an OIDC issuer,
 * null when it doesn't (endpoint absent, unreachable, or invalid). A null
 * result just means "no OAuth here" - the caller falls back to probing
 * legacy login flows.
 */
export async function probeDelegatedAuth(
	baseUrl: string,
): Promise<OidcClientConfig | null> {
	try {
		// getAuthMetadata fetches /auth_metadata, falling back to the legacy
		// /auth_issuer + issuer discovery, and validates the result.
		return await createClient({ baseUrl }).getAuthMetadata();
	} catch {
		return null;
	}
}

/**
 * Absolute URL the OP redirects back to after authorization. Registered as
 * the sole redirect URI at dynamic registration time, so the formula must
 * stay stable for a given deployment (origin + Vite base + callback route).
 */
export function oidcRedirectUri(): string {
	return `${window.location.origin}${basePrefix}/login/callback`;
}

/** Absolute URL advertised as the client's home page at registration. */
function oidcClientUri(): string {
	return `${window.location.origin}${basePrefix}/`;
}

// --- Dynamic client registration cache (localStorage, keyed by issuer) ---

function readRegistrationCache(): Record<string, string> {
	const raw = safeLocalStorage.get(STORAGE_KEYS.oidcClientRegistrations);
	if (raw === null) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return {};
		const out: Record<string, string> = {};
		for (const [issuer, clientId] of Object.entries(parsed)) {
			if (typeof clientId === "string" && clientId.length > 0) {
				out[issuer] = clientId;
			}
		}
		return out;
	} catch {
		return {};
	}
}

/** This install's registered client_id for an issuer, if previously registered. */
export function getCachedClientId(issuer: string): string | null {
	return readRegistrationCache()[issuer] ?? null;
}

/**
 * Best-effort: a failed write just means the next login re-registers, which
 * is wasteful but harmless, so there is no error surface here.
 */
function cacheClientId(issuer: string, clientId: string): void {
	const cache = readRegistrationCache();
	cache[issuer] = clientId;
	safeLocalStorage.set(
		STORAGE_KEYS.oidcClientRegistrations,
		JSON.stringify(cache),
	);
}

// --- returnTo stash (sessionStorage; survives the OP round trip) ---

const RETURN_TO_KEY = "crust:oidc-return-to";

/**
 * Remember where to send the user after login. Router state (where the
 * password flow carries returnTo) does not survive the full-page redirect
 * to the OP and back, so the OAuth flow stashes it in sessionStorage.
 */
export function stashOidcReturnTo(path: string): void {
	try {
		sessionStorage.setItem(RETURN_TO_KEY, path);
	} catch {
		// Storage denied (private mode etc.) - fall back to home after login.
	}
}

/** Read and clear the stashed post-login target; null when absent. */
export function takeOidcReturnTo(): string | null {
	try {
		const value = sessionStorage.getItem(RETURN_TO_KEY);
		sessionStorage.removeItem(RETURN_TO_KEY);
		return value;
	} catch {
		return null;
	}
}

// --- Signin state (sessionStorage; survives the OP round trip) ---
//
// One shared key means only one OAuth login can be in flight per tab
// session: starting a second login overwrites the first's state (the
// first tab's callback then fails closed with "started elsewhere"), and a
// mismatched callback clears the state before failing. That is a
// deliberate fail-closed tradeoff, not a race worth defending further.

const SIGNIN_STATE_KEY = "crust:oidc-signin-state";

/** Everything the callback needs to complete the flow we started. */
interface OidcSigninState {
	state: string;
	codeVerifier: string;
	nonce: string;
	homeserverUrl: string;
	issuer: string;
	clientId: string;
	tokenEndpoint: string;
}

function storeSigninState(signin: OidcSigninState): void {
	try {
		sessionStorage.setItem(SIGNIN_STATE_KEY, JSON.stringify(signin));
	} catch {
		// Storage denied: the callback will report "login session expired".
	}
}

/**
 * Read and clear the stored signin state. Single-use by design: a replayed
 * callback finds nothing and fails closed. Null when absent or malformed.
 */
function takeSigninState(): OidcSigninState | null {
	let raw: string | null = null;
	try {
		raw = sessionStorage.getItem(SIGNIN_STATE_KEY);
		sessionStorage.removeItem(SIGNIN_STATE_KEY);
	} catch {
		return null;
	}
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const s = parsed as Record<string, unknown>;
		for (const field of [
			"state",
			"codeVerifier",
			"nonce",
			"homeserverUrl",
			"issuer",
			"clientId",
			"tokenEndpoint",
		] as const) {
			if (typeof s[field] !== "string" || (s[field] as string).length === 0) {
				return null;
			}
		}
		return parsed as OidcSigninState;
	} catch {
		return null;
	}
}

// --- Random / PKCE helpers ---

/** Cryptographically random base64url string from `n` bytes of entropy. */
function secureRandomBase64Url(n: number): string {
	const bytes = new Uint8Array(n);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** S256 PKCE challenge for a verifier (RFC 7636). */
async function pkceChallengeS256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	const bytes = new Uint8Array(digest);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * Begin the authorization code flow: register this install with the OP
 * (reusing the cached registration when present), store the signin state,
 * and build the authorization URL. The caller navigates the full page to
 * the returned URL.
 *
 * @throws when dynamic registration fails, the OP rejects the metadata, or
 *         the metadata's authorization endpoint is not a web URL.
 */
export async function startOidcLogin(
	metadata: OidcClientConfig,
	homeserverUrl: string,
): Promise<string> {
	const redirectUri = oidcRedirectUri();
	let clientId = getCachedClientId(metadata.issuer);
	if (!clientId) {
		clientId = await registerOidcClient(metadata, {
			clientName: "Crust",
			clientUri: oidcClientUri(),
			applicationType: "web",
			redirectUris: [redirectUri],
			// The SDK's metadata type marks these keys required (values may be
			// undefined); Crust publishes no contacts or policy pages.
			contacts: undefined,
			tosUri: undefined,
			policyUri: undefined,
		});
		cacheClientId(metadata.issuer, clientId);
	}

	const signin: OidcSigninState = {
		state: secureRandomBase64Url(16),
		codeVerifier: secureRandomBase64Url(64),
		nonce: secureRandomBase64Url(16),
		homeserverUrl,
		issuer: metadata.issuer,
		clientId,
		tokenEndpoint: metadata.token_endpoint,
	};

	// The authorization endpoint comes from homeserver-supplied metadata. A
	// javascript: URL handed to window.location.assign would execute in
	// Crust's origin, so the scheme is pinned to web protocols before the
	// URL is built.
	let authorizationUrl: URL;
	try {
		authorizationUrl = new URL(metadata.authorization_endpoint);
	} catch {
		throw new Error("The homeserver returned an invalid login URL.");
	}
	if (
		authorizationUrl.protocol !== "https:" &&
		authorizationUrl.protocol !== "http:"
	) {
		throw new Error("The homeserver returned an invalid login URL.");
	}

	authorizationUrl.searchParams.set("response_type", "code");
	authorizationUrl.searchParams.set("client_id", clientId);
	authorizationUrl.searchParams.set("redirect_uri", redirectUri);
	// generateScope() covers everything needed: the Matrix API scope, a
	// fresh device ID for this login, and "openid" (what makes OIDC-pure
	// OPs issue an id_token; Continuwuity parses and ignores it).
	authorizationUrl.searchParams.set("scope", generateScope());
	authorizationUrl.searchParams.set("state", signin.state);
	authorizationUrl.searchParams.set("nonce", signin.nonce);
	authorizationUrl.searchParams.set(
		"code_challenge",
		await pkceChallengeS256(signin.codeVerifier),
	);
	authorizationUrl.searchParams.set("code_challenge_method", "S256");

	storeSigninState(signin);
	return authorizationUrl.toString();
}

/** Everything the session store needs after a successful OAuth login. */
export interface OidcLoginResult {
	accessToken: string;
	refreshToken?: string;
	userId: string;
	deviceId: string;
	homeserverUrl: string;
	oidc: {
		issuer: string;
		clientId: string;
		/** Present only when the OP issues OIDC ID tokens. */
		idToken?: string;
		/** Token endpoint for the refresh path. */
		tokenEndpoint: string;
	};
}

/** Shape of a successful token-endpoint response we rely on. */
interface TokenEndpointResponse {
	access_token: string;
	token_type: string;
	refresh_token?: string;
	expires_in?: number;
	id_token?: string;
}

function isTokenEndpointResponse(
	value: unknown,
): value is TokenEndpointResponse {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	if (typeof r.access_token !== "string" || r.access_token.length === 0) {
		return false;
	}
	// RFC 6750: only bearer tokens are usable against the C-S API.
	if (
		typeof r.token_type !== "string" ||
		r.token_type.toLowerCase() !== "bearer"
	) {
		return false;
	}
	for (const opt of ["refresh_token", "id_token"] as const) {
		// Present-but-empty (or whitespace-only) would persist an unusable
		// credential: an empty refresh_token silently disables refresh
		// (falsy !session.refreshToken).
		if (
			r[opt] !== undefined &&
			(typeof r[opt] !== "string" || (r[opt] as string).trim().length === 0)
		) {
			return false;
		}
	}
	if (r.expires_in !== undefined && typeof r.expires_in !== "number") {
		return false;
	}
	return true;
}

/**
 * Validate an OP-issued id_token's claims. The signature is intentionally
 * NOT verified: the token arrived over a direct TLS back-channel POST to
 * the token endpoint, which OIDC Core accepts as sufficient ("if the ID
 * Token is received via direct communication between the Client and the
 * Token Endpoint, TLS server validation may be used"). iss/aud/nonce/exp
 * are still checked.
 *
 * @throws an Error with a user-presentable message on any mismatch.
 */
function validateIdTokenClaims(
	idToken: string,
	expected: { issuer: string; clientId: string; nonce: string },
): void {
	const invalid =
		"The homeserver's login response failed validation. Try logging in again.";
	let claims: ReturnType<typeof decodeIdToken>;
	try {
		claims = decodeIdToken(idToken);
	} catch {
		throw new Error(invalid);
	}
	if (claims.iss !== expected.issuer) throw new Error(invalid);
	const aud = claims.aud;
	const audMatch = Array.isArray(aud)
		? aud.includes(expected.clientId)
		: aud === expected.clientId;
	if (!audMatch) throw new Error(invalid);
	if (claims.nonce !== expected.nonce) throw new Error(invalid);
	// exp is REQUIRED (OIDC Core): absent or elapsed both fail closed.
	if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
		throw new Error(invalid);
	}
}

/**
 * Complete the authorization code flow on the callback route: verify the
 * returned state against the stored signin state (login-CSRF protection),
 * exchange the code for tokens, then whoami to learn the user/device IDs.
 *
 * @param search - the callback URL's query string (`location.search`).
 * @throws an Error with a user-presentable message on OP-reported errors,
 *         a malformed or replayed callback, a failed exchange, failed
 *         id_token validation, or a missing device ID.
 */
export async function completeOidcLogin(
	search: string,
): Promise<OidcLoginResult> {
	const params = new URLSearchParams(search);

	// The OP reports its own failures (access_denied, server_error, ...) as
	// query params on the redirect - surface them instead of the generic
	// "missing code" error below.
	const oidcError = params.get("error");
	if (oidcError) {
		const description = params.get("error_description");
		throw new Error(
			description
				? `Login failed: ${description} (${oidcError}).`
				: `Login failed (${oidcError}).`,
		);
	}

	const code = params.get("code");
	const stateParam = params.get("state");
	if (!code || !stateParam) {
		throw new Error(
			"This login link is incomplete. Go back and start the login again.",
		);
	}

	// Single-use: cleared on read, so a replayed callback fails closed here.
	const signin = takeSigninState();
	if (!signin || signin.state !== stateParam) {
		throw new Error(
			"This login session has expired or was started elsewhere. Go back and start the login again.",
		);
	}

	// Exchange the authorization code at the token endpoint (PKCE).
	const tokenResponse = await (async (): Promise<TokenEndpointResponse> => {
		let res: Response;
		try {
			res = await fetch(signin.tokenEndpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code,
					redirect_uri: oidcRedirectUri(),
					client_id: signin.clientId,
					code_verifier: signin.codeVerifier,
				}),
			});
		} catch (e) {
			throw new Error(
				userFacingErrorMessage(
					e,
					"Could not complete the login with the homeserver. Try again.",
				),
			);
		}
		if (!res.ok) {
			// RFC 6749 error bodies carry human-readable descriptions.
			let message = `The homeserver rejected the login (${res.status}). Try again.`;
			try {
				const errBody: unknown = await res.json();
				if (
					typeof errBody === "object" &&
					errBody !== null &&
					typeof (errBody as { error_description?: unknown })
						.error_description === "string"
				) {
					message = `Login failed: ${(errBody as { error_description: string }).error_description}`;
				}
			} catch {
				// Non-JSON error body - keep the status-based message.
			}
			throw new Error(message);
		}
		const body: unknown = await (async () => {
			try {
				return await res.json();
			} catch {
				throw new Error(
					"The homeserver's login response was malformed. Try logging in again.",
				);
			}
		})();
		if (!isTokenEndpointResponse(body)) {
			throw new Error(
				"The homeserver's login response was malformed. Try logging in again.",
			);
		}
		return body;
	})();

	// When the OP issues an id_token, validate its claims. Its absence is
	// tolerated (Continuwuity issues none): the whoami below with the fresh
	// access token proves the same identity for login purposes.
	if (tokenResponse.id_token) {
		validateIdTokenClaims(tokenResponse.id_token, {
			issuer: signin.issuer,
			clientId: signin.clientId,
			nonce: signin.nonce,
		});
	}

	// The token response carries no Matrix user/device IDs; whoami with the
	// fresh access token is the canonical way to learn them.
	let whoami: { user_id: string; device_id?: string };
	try {
		whoami = await createClient({
			baseUrl: signin.homeserverUrl,
			accessToken: tokenResponse.access_token,
		}).whoami();
	} catch (e) {
		throw new Error(
			userFacingErrorMessage(
				e,
				"The homeserver could not confirm the new session. Try logging in again.",
			),
		);
	}
	if (!whoami.device_id) {
		throw new Error(
			"The homeserver did not assign a device ID to this session.",
		);
	}

	return {
		accessToken: tokenResponse.access_token,
		refreshToken: tokenResponse.refresh_token,
		userId: whoami.user_id,
		deviceId: whoami.device_id,
		homeserverUrl: signin.homeserverUrl.replace(/\/+$/, ""),
		oidc: {
			issuer: signin.issuer,
			clientId: signin.clientId,
			idToken: tokenResponse.id_token,
			tokenEndpoint: signin.tokenEndpoint,
		},
	};
}
