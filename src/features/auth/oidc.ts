/**
 * OAuth 2.0 (MSC3861 / Matrix v1.18 profile) login flow.
 *
 * Split into framework-free helpers so the LoginPage / LoginCallback
 * components stay thin and everything here is unit-testable in jsdom:
 *
 *  1. {@link probeDelegatedAuth} - does this homeserver delegate auth?
 *  2. {@link startOidcLogin} - dynamic client registration (cached per
 *     issuer) via our own fetch (the SDK's registerClient discards the
 *     OP's error_description, issue #486), then the authorization URL with
 *     PKCE via the SDK's OAuth2 class (it generates the verifier; we
 *     persist it, keyed by state, in our own sessionStorage entry); the
 *     caller navigates to the URL.
 *  3. {@link completeOidcLogin} - verify the returned state, exchange the
 *     code (SDK OAuth2.completeAuthorizationCodeGrant), then whoami for
 *     the user/device IDs.
 *
 * Matrix v1.18's OAuth2 profile does not use OIDC id_tokens; identity at
 * login is proven by the whoami call with the freshly exchanged access
 * token. (SDK 41's OIDC-era flow required an id_token, which broke against
 * OPs that don't issue one, e.g. Continuwuity - see #463.)
 */
import {
	createClient,
	OAuth2,
	type ValidatedAuthMetadata,
} from "matrix-js-sdk";
import { basePrefix } from "../../app/basePath";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { safeLocalStorage } from "../../lib/persistedSignal";
import { STORAGE_KEYS } from "../../lib/storageKeys";

/**
 * Probe a homeserver for MSC3861 delegated auth. Returns validated OP
 * metadata when the server delegates authentication to an OAuth2 issuer,
 * null when it doesn't (endpoint absent, unreachable, or invalid). A null
 * result just means "no OAuth here" - the caller falls back to probing
 * legacy login flows.
 */
export async function probeDelegatedAuth(
	baseUrl: string,
): Promise<ValidatedAuthMetadata | null> {
	try {
		// getAuthMetadata fetches and validates /auth_metadata (throwing
		// OAuth2Error.OpSupport when absent or invalid).
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

/**
 * Register this install with the OP (RFC 7591 dynamic registration).
 * Hand-rolled rather than the SDK's OAuth2.registerClient, which maps every
 * failure to the opaque "Dynamic registration failed" and discards the OP's
 * error_description - exactly the text that diagnoses a rejected
 * client_uri ("Client URI must be HTTPS.", issue #486).
 */
async function registerOidcClient(
	metadata: ValidatedAuthMetadata,
	redirectUri: string,
): Promise<string> {
	if (!metadata.registration_endpoint) {
		// "Login service" like the other registration errors: the metadata is
		// the OP's, which can be a different host than the homeserver.
		throw new Error(
			"The login service does not support automatic app registration.",
		);
	}
	// Pinned to web schemes like the authorization URL below: the endpoint is
	// homeserver-supplied, and in the desktop shell the CSP admits non-web
	// schemes (ipc:) that a fetch must never be steered into.
	let endpoint: URL;
	try {
		endpoint = new URL(metadata.registration_endpoint);
	} catch {
		throw new Error("The login service metadata is invalid.");
	}
	if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
		throw new Error("The login service metadata is invalid.");
	}
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				client_name: "Crust",
				client_uri: oidcClientUri(),
				application_type: "web",
				redirect_uris: [redirectUri],
				// Sent explicitly although RFC 7591 makes them optional: the
				// RFC's defaults when omitted are ["code"] and
				// ["authorization_code"] alone - an OP applying them would
				// register this app WITHOUT the refresh grant it later uses.
				// This cannot over-restrict either: getAuthMetadata validation
				// already refuses OPs whose grant_types_supported lacks
				// refresh_token, so every OP that reaches this request
				// advertises both. (The SDK's own default additionally asks
				// for the device grant, which this app never uses.)
				response_types: ["code"],
				grant_types: ["authorization_code", "refresh_token"],
				token_endpoint_auth_method: "none",
			}),
		});
	} catch {
		// "Login service", not "homeserver": the registration endpoint belongs
		// to the OP from the auth metadata, which can be a different host.
		throw new Error(
			"Could not reach the login service to register this app. Check your connection and try again.",
		);
	}
	if (!response.ok) {
		// Surface the OP's reason when it gives one. Server-controlled text:
		// rendered as plain text by the error banner, and capped so a
		// misbehaving server can't flood the UI.
		let description = "";
		try {
			const body: unknown = await response.json();
			const d = (body as { error_description?: unknown }).error_description;
			if (typeof d === "string") description = d.slice(0, 200);
		} catch {
			// Non-JSON error body - fall through to the generic message.
		}
		throw new Error(
			description
				? `The login service rejected this app's registration: ${description}`
				: `Dynamic registration failed (HTTP ${response.status}).`,
		);
	}
	let clientId: unknown;
	try {
		clientId = ((await response.json()) as { client_id?: unknown }).client_id;
	} catch {
		// Handled below: a non-JSON success body has no client_id.
	}
	if (typeof clientId !== "string" || clientId.length === 0) {
		throw new Error(
			"The login service returned an invalid registration response.",
		);
	}
	return clientId;
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

const ADD_ACCOUNT_KEY = "crust:oidc-add-account";

/**
 * Remember that this OAuth login is adding an account rather than replacing the
 * current one (#533). Same reason as the returnTo stash: router state does not
 * survive the full-page redirect to the OP. Written only by our own
 * "Add account" action, immediately before the redirect.
 */
export function stashOidcAddAccount(): void {
	try {
		sessionStorage.setItem(ADD_ACCOUNT_KEY, "1");
	} catch {
		// Storage denied - the callback then treats it as a plain login, which
		// replaces rather than appends. Failing this way round is deliberate:
		// the worst case is the user has to log the other account back in, not a
		// stray token left behind by an append nobody asked for.
	}
}

/** Read and clear the add-account intent for a completing OAuth login. */
export function takeOidcAddAccount(): boolean {
	try {
		const value = sessionStorage.getItem(ADD_ACCOUNT_KEY);
		sessionStorage.removeItem(ADD_ACCOUNT_KEY);
		return value === "1";
	} catch {
		return false;
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
	/** PKCE verifier generated by the SDK's OAuth2 instance at start. */
	codeVerifier: string;
	homeserverUrl: string;
	issuer: string;
	clientId: string;
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
			"homeserverUrl",
			"issuer",
			"clientId",
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

/**
 * Begin the authorization code flow: register this install with the OP
 * (reusing the cached registration when present), store the signin state,
 * and build the authorization URL. The caller navigates the full page to
 * the returned URL.
 *
 * @throws when dynamic registration fails, the OP rejects the metadata, or
 *         the generated URL is not a web URL.
 */
export async function startOidcLogin(
	metadata: ValidatedAuthMetadata,
	homeserverUrl: string,
): Promise<string> {
	const redirectUri = oidcRedirectUri();
	let clientId = getCachedClientId(metadata.issuer);
	if (!clientId) {
		clientId = await registerOidcClient(metadata, redirectUri);
		cacheClientId(metadata.issuer, clientId);
	}

	// The OAuth2 instance generates the PKCE verifier; we persist it (keyed
	// by our state) so the callback can complete the exchange.
	const auth = new OAuth2(metadata, { clientId, redirectUri });
	const signin: OidcSigninState = {
		state: secureRandomBase64Url(16),
		codeVerifier: auth.context.codeVerifier,
		homeserverUrl,
		issuer: metadata.issuer,
		clientId,
	};
	// "query" response mode: the callback route reads the query string. The
	// SDK default is "fragment" (keeps the code out of logs); same-origin
	// self-hosted deployments make the difference negligible, and query
	// keeps the callback handler trivial.
	const authorizationUrl = await auth.generateAuthorizationCodeGrantUrl(
		signin.state,
		"query",
	);

	// The authorization endpoint comes from homeserver-supplied metadata. A
	// javascript: URL handed to window.location.assign would execute in
	// Crust's origin, so the scheme is pinned to web protocols.
	let parsed: URL;
	try {
		parsed = new URL(authorizationUrl);
	} catch {
		throw new Error("The homeserver returned an invalid login URL.");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("The homeserver returned an invalid login URL.");
	}

	storeSigninState(signin);
	return authorizationUrl;
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
	};
}

/**
 * Complete the authorization code flow on the callback route: verify the
 * returned state against the stored signin state (login-CSRF protection),
 * exchange the code for tokens via the SDK, then whoami to learn the
 * user/device IDs.
 *
 * @param search - the callback URL's query string (`location.search`).
 * @throws an Error with a user-presentable message on OP-reported errors,
 *         a malformed or replayed callback, a failed exchange, or a
 *         missing device ID.
 */
export async function completeOidcLogin(
	search: string,
): Promise<OidcLoginResult> {
	const params = new URLSearchParams(search);

	// The OP reports its own failures (access_denied, server_error, ...) as
	// query params on the redirect - surface them instead of the generic
	// "missing code" error below.
	// Both params capped like the registration path: OP-controlled text,
	// rendered in the error banner - and reachable by anyone crafting a
	// callback URL.
	const oidcError = params.get("error")?.slice(0, 200);
	if (oidcError) {
		const description = params.get("error_description")?.slice(0, 200);
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

	// Rebuild the OAuth2 context: metadata is refetched (cheap, and must
	// match whatever the OP currently advertises), the rest comes from the
	// stored signin state.
	let tokenResponse: Awaited<
		ReturnType<OAuth2["completeAuthorizationCodeGrant"]>
	>;
	try {
		const metadata = await createClient({
			baseUrl: signin.homeserverUrl,
		}).getAuthMetadata();
		const auth = new OAuth2(metadata, {
			clientId: signin.clientId,
			codeVerifier: signin.codeVerifier,
			redirectUri: oidcRedirectUri(),
		});
		tokenResponse = await auth.completeAuthorizationCodeGrant(code);
	} catch (e) {
		throw new Error(
			userFacingErrorMessage(
				e,
				"Could not complete the login with the homeserver. Try again.",
			),
		);
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
		...(tokenResponse.refresh_token
			? { refreshToken: tokenResponse.refresh_token }
			: {}),
		userId: whoami.user_id,
		deviceId: whoami.device_id,
		homeserverUrl: signin.homeserverUrl.replace(/\/+$/, ""),
		oidc: {
			issuer: signin.issuer,
			clientId: signin.clientId,
		},
	};
}
