import type { AccessTokens } from "matrix-js-sdk/lib/http-api";
import {
	loadSessions,
	type Session,
	type SessionOidc,
	updateSession,
} from "../../stores/session";
import { withSessionLock } from "../../stores/sessionLock";

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
async function persistRefreshedTokens(
	identity: SessionIdentity,
	tokens: { accessToken: string; refreshToken?: string },
): Promise<void> {
	try {
		await withSessionLock(() => {
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
			updateSession(rotated);
		});
	} catch (e) {
		console.warn("Failed to persist refreshed OAuth2 tokens:", e);
	}
}

/** Persist SDK-managed OAuth refreshes without overwriting a replaced account. */
export function createOidcTokenRefreshCallback(
	session: Session,
): ((tokens: AccessTokens) => Promise<void>) | undefined {
	if (!session.oidc) return undefined;
	const identity = identityOf(session as Session & { oidc: SessionOidc });
	let latestRefreshToken = session.refreshToken;
	return (tokens) => {
		// SDK 44 replaces its in-memory token with this object after the callback.
		// Persist only the provider response so another tab's stored rotation survives.
		const received = { ...tokens };
		if (tokens.refreshToken) latestRefreshToken = tokens.refreshToken;
		else if (latestRefreshToken) tokens.refreshToken = latestRefreshToken;
		return persistRefreshedTokens(identity, received);
	};
}
