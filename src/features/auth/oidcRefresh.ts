/**
 * Access-token refresh wiring for OAuth2 (MSC3861) sessions.
 *
 * Password sessions never carry a refresh token, so this is a no-op for
 * them. OAuth sessions get the SDK's TokenRefresher, built lazily on first
 * use (constructing it needs the OP metadata, which is a network fetch),
 * with an onRefresh that persists rotated tokens back into the session
 * store - identity-guarded, so a replaced session is never clobbered.
 *
 * Caveats, documented so their symptoms aren't mysteries:
 *
 *  - If the OP does NOT rotate refresh tokens (response without a new
 *    refresh_token), the SDK's http-api ends up with no refresh token for
 *    the RUNNING client at the second expiry, ending the session via the
 *    normal SessionLoggedOut flow. The persisted store keeps the old
 *    token, so a reload recovers.
 *  - Two open tabs each hold their own in-memory refresh token; when both
 *    refresh, the slower tab presents a rotated-out token and is logged
 *    out (invalid_grant). The guarded persistence prevents the losing tab
 *    from resurrecting the stale token in storage, but cannot save the
 *    tab itself.
 */
import { createClient, OAuth2, TokenRefresher } from "matrix-js-sdk";
import type { TokenRefreshFunction } from "matrix-js-sdk/lib/http-api";
import {
	loadSessions,
	type Session,
	type SessionOidc,
	updateSession,
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
 *
 * The account is looked up by user ID rather than taken as "the active
 * session": a refresh in flight across an account switch belongs to the
 * account it was issued for, and `updateSession` writes it there without
 * disturbing which account is active. An account removed meanwhile is not
 * resurrected - `updateSession` only ever replaces an existing entry.
 */
function persistRefreshedTokens(
	identity: SessionIdentity,
	tokens: { accessToken: string; refreshToken?: string },
): void {
	// Reload from storage rather than closing over the boot-time session:
	// another tab may have rotated the refresh token since this window
	// loaded, and we must not resurrect the stale one.
	const session = loadSessions().find((s) => s.userId === identity.userId);
	if (!session?.oidc) return;
	if (
		session.deviceId !== identity.deviceId ||
		session.oidc.issuer !== identity.issuer ||
		session.oidc.clientId !== identity.clientId
	) {
		return;
	}
	const rotated: Session = { ...session, accessToken: tokens.accessToken };
	// Truthiness, not `??`: an OP that answers with an EMPTY refresh_token has not
	// rotated it, and storing "" would fail session validation - losing the new
	// access token too, for a forced re-login on the next reload.
	if (tokens.refreshToken) rotated.refreshToken = tokens.refreshToken;
	try {
		updateSession(rotated);
	} catch (e) {
		console.warn("Failed to persist refreshed OAuth2 tokens:", e);
	}
}

/**
 * Build the SDK `tokenRefreshFunction` for a session, or undefined when the
 * session has nothing to refresh with (password sessions, or OAuth2 sessions
 * whose OP issued no refresh token). The SDK TokenRefresher is constructed
 * lazily because it needs the OP's auth metadata (a network fetch); the
 * refresh mapping is the SDK's. Since matrix-js-sdk 42.3 only a 4xx whose
 * body is an OAuth 2.0 error (RFC 6749) or a Matrix error ends the session
 * (TokenRefreshLogoutError); any other 4xx - a proxy's HTML 403, an empty
 * 400 - is a transient failure like a 5xx or a network error, retried by
 * the sync loop rather than logging the user out. A refresh that keeps
 * failing that way leaves the client in the sync-error state, where the
 * escape hatch (#551) is the way out.
 */
export function createOidcTokenRefreshFn(
	session: Session,
): TokenRefreshFunction | undefined {
	if (!session.oidc || !session.refreshToken) return undefined;
	const oidcSession = session as Session & { oidc: SessionOidc };
	const identity = identityOf(oidcSession);

	let refresherPromise: Promise<TokenRefresher> | null = null;
	const getRefresher = (): Promise<TokenRefresher> =>
		(refresherPromise ??= (async () => {
			const metadata = await createClient({
				baseUrl: session.homeserverUrl,
			}).getAuthMetadata();
			const auth = new OAuth2(metadata, {
				clientId: oidcSession.oidc.clientId,
				redirectUri: oidcRedirectUri(),
			});
			return new TokenRefresher(auth, async (tokens) => {
				persistRefreshedTokens(identity, tokens);
			});
		})());

	return async (refreshToken) => {
		const refresher = await getRefresher();
		return refresher.tokenRefreshFunction(refreshToken);
	};
}
