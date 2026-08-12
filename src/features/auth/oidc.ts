/**
 * OAuth 2.0 / OIDC (MSC3861 delegated auth) login flow.
 *
 * Split into framework-free helpers so the LoginPage / LoginCallback
 * components stay thin and everything here is unit-testable in jsdom:
 *
 *  1. {@link probeDelegatedAuth} - does this homeserver delegate auth?
 *  2. {@link startOidcLogin} - dynamic client registration (cached per
 *     issuer) + authorization URL generation; the caller navigates to it.
 *  3. {@link completeOidcLogin} - code exchange on the callback route +
 *     whoami to learn the user/device IDs the session store needs.
 *
 * The PKCE state the SDK stashes (via oidc-client-ts) lives in
 * sessionStorage, as does our `returnTo` stash - both survive the
 * full-page round trip to the OP in the same tab.
 */
import {
	completeAuthorizationCodeGrant,
	createClient,
	generateOidcAuthorizationUrl,
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

/** 128 bits of entropy, base64url-encoded, for the OIDC nonce. */
function generateNonce(): string {
	const bytes = new Uint8Array(16);
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
 * (reusing the cached registration when present) and build the
 * authorization URL. The caller navigates the full page to it.
 *
 * @throws when dynamic registration fails, the OP rejects the metadata, or
 *         the generated URL is not a web URL.
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
	const authorizationUrl = await generateOidcAuthorizationUrl({
		metadata,
		clientId,
		homeserverUrl,
		redirectUri,
		nonce: generateNonce(),
	});
	// The authorization endpoint comes from homeserver-supplied metadata and
	// the SDK emits it verbatim (validateAuthMetadata only checks the field
	// is a string). A javascript: URL handed to window.location.assign would
	// execute in Crust's origin, so the scheme is pinned to web protocols.
	let parsed: URL;
	try {
		parsed = new URL(authorizationUrl);
	} catch {
		throw new Error("The homeserver returned an invalid login URL.");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("The homeserver returned an invalid login URL.");
	}
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
		idToken: string;
	};
}

/**
 * Complete the authorization code flow on the callback route: exchange the
 * code for tokens, then whoami to learn the user/device IDs.
 *
 * @param search - the callback URL's query string (`location.search`).
 * @throws an Error with a user-presentable message on OP-reported errors,
 *         a malformed callback, a failed exchange, or a missing device ID.
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
	const state = params.get("state");
	if (!code || !state) {
		throw new Error(
			"This login link is incomplete. Go back and start the login again.",
		);
	}

	let grant: Awaited<ReturnType<typeof completeAuthorizationCodeGrant>>;
	try {
		grant = await completeAuthorizationCodeGrant(code, state);
	} catch (e) {
		throw new Error(
			userFacingErrorMessage(
				e,
				"Could not complete the login with the homeserver. Try again.",
			),
		);
	}
	const { oidcClientSettings, tokenResponse, homeserverUrl } = grant;

	// The token response carries no Matrix user/device IDs; whoami with the
	// fresh access token is the canonical way to learn them.
	let whoami: { user_id: string; device_id?: string };
	try {
		whoami = await createClient({
			baseUrl: homeserverUrl,
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
		homeserverUrl: homeserverUrl.replace(/\/+$/, ""),
		oidc: {
			issuer: oidcClientSettings.issuer,
			clientId: oidcClientSettings.clientId,
			idToken: tokenResponse.id_token,
		},
	};
}
