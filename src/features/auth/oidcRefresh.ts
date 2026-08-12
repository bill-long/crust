/**
 * Access-token refresh wiring for OIDC (MSC3861) sessions.
 *
 * Password sessions never carry a refresh token, so this is a no-op for
 * them. OIDC sessions get one of two refresh paths:
 *
 *  - The OP issues OIDC ID tokens (MAS-style): an `OidcTokenRefresher`
 *    subclass, which validates refreshed ID tokens against the original
 *    grant's claims.
 *  - The OP issues no ID tokens (Continuwuity's built-in OAuth server):
 *    a direct refresh-token grant against the persisted token endpoint.
 *
 * Both persist rotated tokens back into the session store through the same
 * identity-guarded writer, so a reload keeps the freshest (still-valid)
 * refresh token and a replaced session is never clobbered.
 *
 * Caveats, documented so their symptoms aren't mysteries:
 *
 *  - The OidcTokenRefresher path does not carry an old refresh token
 *    forward when the OP doesn't rotate (oidc-client-ts behavior), so a
 *    RUNNING client on a non-rotating OP ends at the second expiry via the
 *    normal SessionLoggedOut flow; the persisted store keeps the old
 *    token, so a reload recovers. The direct path below carries the old
 *    token forward and is not affected.
 *  - Two open tabs each hold their own in-memory refresh token; when both
 *    refresh, the slower tab presents a rotated-out token and is logged
 *    out (invalid_grant). The guarded persistence prevents the losing tab
 *    from resurrecting the stale token in storage, but cannot save the
 *    tab itself.
 */
import {
	decodeIdToken,
	OidcTokenRefresher,
	TokenRefreshLogoutError,
} from "matrix-js-sdk";
import type {
	AccessTokens,
	TokenRefreshFunction,
} from "matrix-js-sdk/lib/http-api";
import {
	loadSession,
	type Session,
	type SessionOidc,
	saveSession,
} from "../../stores/session";
import { oidcRedirectUri } from "./oidc";

/** Identity of a boot-time session, for the clobber guard below. */
interface SessionIdentity {
	userId: string;
	deviceId: string;
	issuer: string;
	clientId: string;
}

function identityOf(session: Session & { oidc: SessionOidc }): SessionIdentity {
	return {
		userId: session.userId,
		deviceId: session.deviceId,
		issuer: session.oidc.issuer,
		clientId: session.oidc.clientId,
	};
}

/**
 * Persist refreshed tokens, but ONLY when storage still holds the exact
 * session this refresher was built for. A logout/login since boot
 * (different account, a new device, or a password session) must not have
 * its tokens overwritten by a late refresh from the replaced session.
 * Best-effort: a failed write leaves the in-memory client working at the
 * cost of a forced re-login after the next reload once the old refresh
 * token has been rotated out.
 */
function persistRefreshedTokens(
	identity: SessionIdentity,
	tokens: { accessToken: string; refreshToken?: string },
): void {
	// Reload from storage rather than closing over the boot-time session:
	// another tab may have rotated the refresh token since this window
	// loaded, and we must not resurrect the stale one.
	const session = loadSession();
	if (!session?.oidc) return;
	if (
		session.userId !== identity.userId ||
		session.deviceId !== identity.deviceId ||
		session.oidc.issuer !== identity.issuer ||
		session.oidc.clientId !== identity.clientId
	) {
		return;
	}
	session.accessToken = tokens.accessToken;
	if (tokens.refreshToken) session.refreshToken = tokens.refreshToken;
	try {
		saveSession(session);
	} catch (e) {
		console.warn("Failed to persist refreshed OIDC tokens:", e);
	}
}

class PersistingOidcTokenRefresher extends OidcTokenRefresher {
	private readonly identity: SessionIdentity;

	constructor(session: Session & { oidc: SessionOidc }) {
		super(
			session.oidc.issuer,
			session.oidc.clientId,
			oidcRedirectUri(),
			session.deviceId,
			// session.oidc.idToken is guaranteed present by the caller's
			// path selection (see createOidcTokenRefreshFn).
			decodeIdToken(session.oidc.idToken as string),
		);
		this.identity = identityOf(session);
	}

	protected override async persistTokens(tokens: {
		accessToken: string;
		refreshToken?: string;
	}): Promise<void> {
		persistRefreshedTokens(this.identity, tokens);
	}
}

/** Shape of a refresh-grant response we rely on. */
interface RefreshGrantResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
}

function isRefreshGrantResponse(value: unknown): value is RefreshGrantResponse {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.access_token === "string" &&
		r.access_token.length > 0 &&
		(r.refresh_token === undefined ||
			(typeof r.refresh_token === "string" && r.refresh_token.length > 0)) &&
		(r.expires_in === undefined || typeof r.expires_in === "number")
	);
}

/**
 * Direct refresh-token grant for OPs that issue no ID tokens. On
 * invalid_grant (refresh token dead) or invalid_client (registration
 * revoked) the session is genuinely unrecoverable - TokenRefreshLogoutError
 * tells the SDK's http-api to take the SessionLoggedOut path; any other
 * failure reads as transient and is retried.
 */
function createDirectRefreshFn(
	session: Session & { oidc: SessionOidc },
): TokenRefreshFunction {
	const identity = identityOf(session);
	const { tokenEndpoint, clientId } = session.oidc;
	return async (refreshToken) => {
		let res: Response;
		try {
			res = await fetch(tokenEndpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: refreshToken,
					client_id: clientId,
				}),
			});
		} catch (e) {
			// Network-level failure: transient, the SDK retries.
			throw e instanceof Error ? e : new Error("Token refresh request failed");
		}
		if (res.status === 400 || res.status === 401) {
			// Only invalid_grant (refresh token dead) and invalid_client
			// (registration revoked) are terminal; other 4xx codes
			// (invalid_request, temporarily_unavailable, unparseable bodies)
			// read as transient and the SDK retries.
			let oauthError: string | undefined;
			try {
				const errBody: unknown = await res.json();
				if (
					typeof errBody === "object" &&
					errBody !== null &&
					typeof (errBody as { error?: unknown }).error === "string"
				) {
					oauthError = (errBody as { error: string }).error;
				}
			} catch {
				// Unparseable body - treat as transient below.
			}
			if (oauthError === "invalid_grant" || oauthError === "invalid_client") {
				throw new TokenRefreshLogoutError(
					new Error(`OIDC refresh was rejected by the server (${oauthError})`),
				);
			}
			throw new Error(
				`Token refresh failed with status ${res.status}${oauthError ? ` (${oauthError})` : ""}`,
			);
		}
		if (!res.ok) {
			throw new Error(`Token refresh failed with status ${res.status}`);
		}
		const body: unknown = await res.json();
		if (!isRefreshGrantResponse(body)) {
			throw new Error("Token refresh response was malformed");
		}
		const tokens: AccessTokens = {
			accessToken: body.access_token,
			// Carry the old refresh token forward when the OP doesn't rotate -
			// the SDK refresher's second-expiry logout does not apply here.
			refreshToken: body.refresh_token ?? refreshToken,
			expiry:
				typeof body.expires_in === "number"
					? new Date(Date.now() + body.expires_in * 1000)
					: undefined,
		};
		persistRefreshedTokens(identity, {
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
		});
		return tokens;
	};
}

/**
 * Build the SDK `tokenRefreshFunction` for a session, or undefined when the
 * session has nothing to refresh with (password sessions, or OIDC sessions
 * whose OP issued no refresh token).
 */
export function createOidcTokenRefreshFn(
	session: Session,
): TokenRefreshFunction | undefined {
	if (!session.oidc || !session.refreshToken) return undefined;
	const oidcSession = session as Session & { oidc: SessionOidc };
	try {
		if (session.oidc.idToken) {
			const refresher = new PersistingOidcTokenRefresher(oidcSession);
			return (refreshToken) => refresher.doRefreshAccessToken(refreshToken);
		}
		return createDirectRefreshFn(oidcSession);
	} catch (e) {
		// A corrupt persisted ID token must not take down client boot - the
		// session still works until the access token expires, after which the
		// normal SessionLoggedOut flow sends the user back to login.
		console.warn("Failed to initialize OIDC token refresh:", e);
		return undefined;
	}
}
