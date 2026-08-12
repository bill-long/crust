/**
 * Access-token refresh wiring for OIDC (MSC3861) sessions.
 *
 * Password sessions never carry a refresh token, so this is a no-op for
 * them. OIDC sessions get an `OidcTokenRefresher` subclass whose
 * `persistTokens` writes rotated tokens back into the session store, so a
 * reload keeps the freshest (still-valid) refresh token.
 *
 * Two SDK-inherent caveats, documented so their symptoms aren't mysteries:
 *
 *  - An OP that does NOT rotate refresh tokens (response without a new
 *    refresh_token) leaves the RUNNING client without one at the second
 *    expiry (oidc-client-ts doesn't carry the old token forward), ending
 *    the session via the normal SessionLoggedOut flow. The persisted
 *    store keeps the old token, so a reload recovers. MSC3861 OPs rotate,
 *    so this is latent for our servers.
 *  - Two open tabs each hold their own in-memory refresh token; when both
 *    refresh, the slower tab presents a rotated-out token and is logged
 *    out (invalid_grant). The persistTokens reload below prevents the
 *    losing tab from resurrecting the stale token in storage, but cannot
 *    save the tab itself.
 */
import { decodeIdToken, OidcTokenRefresher } from "matrix-js-sdk";
import type { TokenRefreshFunction } from "matrix-js-sdk/lib/http-api";
import {
	loadSession,
	type Session,
	type SessionOidc,
	saveSession,
} from "../../stores/session";
import { oidcRedirectUri } from "./oidc";

class PersistingOidcTokenRefresher extends OidcTokenRefresher {
	constructor(session: Session & { oidc: SessionOidc }) {
		super(
			session.oidc.issuer,
			session.oidc.clientId,
			oidcRedirectUri(),
			session.deviceId,
			decodeIdToken(session.oidc.idToken),
		);
	}

	protected override async persistTokens(tokens: {
		accessToken: string;
		refreshToken?: string;
	}): Promise<void> {
		// Reload from storage rather than closing over the boot-time session:
		// another tab may have rotated the refresh token since this window
		// loaded, and we must not resurrect the stale one.
		const session = loadSession();
		if (!session) return;
		session.accessToken = tokens.accessToken;
		if (tokens.refreshToken) session.refreshToken = tokens.refreshToken;
		try {
			saveSession(session);
		} catch (e) {
			// A failed write leaves the in-memory client working; the cost is
			// a forced re-login after the next reload once the old refresh
			// token has been rotated out.
			console.warn("Failed to persist refreshed OIDC tokens:", e);
		}
	}
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
	try {
		const refresher = new PersistingOidcTokenRefresher(
			session as Session & { oidc: SessionOidc },
		);
		return (refreshToken) => refresher.doRefreshAccessToken(refreshToken);
	} catch (e) {
		// A corrupt persisted ID token must not take down client boot - the
		// session still works until the access token expires, after which the
		// normal SessionLoggedOut flow sends the user back to login.
		console.warn("Failed to initialize OIDC token refresh:", e);
		return undefined;
	}
}
