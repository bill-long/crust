/**
 * Logging an account out when it is NOT the one on screen (#533).
 *
 * The switcher can remove any account, and only the active one has a running
 * `MatrixClient`. Rather than switching to an account just to log it out - a
 * visible detour that would tear down the account the user is actually using -
 * this builds a throwaway client from the stored credentials, revokes the token
 * with it, and wipes that account's crypto store.
 *
 * The throwaway client is never started, which is what makes this safe:
 * `clearStores` refuses to run on a running client, no sync is opened, and
 * nothing here can touch the active account's databases because every call is
 * scoped by the account's own `cryptoPrefix` (#532).
 *
 * The revoke itself - stop, abort, bounded keepalive `POST /logout` - is the
 * one every logout uses, foreground included (`app/logout.ts`, #555), so it
 * lives here with its bound rather than in the app layer.
 */
import { createClient, type MatrixClient, Method } from "matrix-js-sdk";
import { createOidcTokenRefreshFn } from "../features/auth/oidcRefresh";
import { reportError } from "../lib/reportError";
import { removeAccount, type Session } from "../stores/session";
import {
	CRYPTO_INIT_TIMEOUT_MS,
	clearCryptoStores,
	withTimeout,
} from "./cryptoRecovery";
import { stopClientFully } from "./stopClientFully";

/**
 * How long a revoke waits for the server before the caller moves on without
 * it. Long enough for a server that is merely stalled on one endpoint to
 * answer, short enough that a logout is never itself a hang. The bad case is
 * not a refused connection (which fails fast) but one that is accepted and then
 * black-holed - hotel wifi, a split-tunnel VPN - where an unbounded await used
 * to wedge the most-used exit in the app (#555) and, behind a background
 * logout, the switcher's single-flight guard for the life of the document.
 * The other waits in a logout are bounded where their own rules live; see
 * `app/logout.ts` for how they add up.
 */
export const REVOKE_TIMEOUT_MS = 5_000;

/**
 * Stop `client` and revoke its token, bounded by {@link REVOKE_TIMEOUT_MS}.
 *
 * The request is sent with fetch `keepalive`, so it outlives this document:
 * when the bound expires the `POST /logout` is still in flight, and a caller
 * that goes on to reload into another account (`finishAccountLogout`) would
 * otherwise cancel it - a revoke that would have landed a second later lost,
 * and the device alive on the homeserver with a working token and no UI left
 * to reach it. With `keepalive` the browser finishes the request on its own.
 * One case stays open: an OAuth session whose access token has expired
 * refreshes it first, and that refresh is a plain request the reload does
 * cancel, so the revoke never starts. Closing it would mean a keepalive
 * refresh, which is the SDK's transport, not ours.
 *
 * Mirrors `client.logout(true)`: the client is stopped and its in-flight
 * requests aborted before the revoke is issued, so nothing races a token that
 * is about to stop working. The stop is `stopClientFully`, which neither
 * throws nor leaves `clientRunning` set - a stop that skipped the request, or
 * left the flag up for the wipe to trip over, would defeat the call. Throws
 * on failure or timeout of the request itself.
 *
 * The bound is a `withTimeout` race, not the SDK's `localTimeoutMs` on the
 * same request: the SDK implements that option as an abort signal, which
 * would cancel the keepalive request at the bound - the one thing this
 * function exists not to do.
 */
export async function revokeSession(client: MatrixClient): Promise<void> {
	stopClientFully(client);
	client.http.abort();
	await withTimeout(
		client.http.authedRequest(Method.Post, "/logout", undefined, undefined, {
			keepAlive: true,
		}),
		REVOKE_TIMEOUT_MS,
		"Session revoke",
	);
}

/**
 * A throwaway client for `account`, never started.
 *
 * Exported because logging an account out is not the only thing this install
 * owes a background account: it also has to take this device's push
 * registration off it when the account stops being the active one
 * (`features/notifications/accountPush.ts`, #534). Both need a client for an
 * account whose own client is not running, built the same way.
 */
export function createAccountClient(
	account: Session,
): ReturnType<typeof createClient> {
	const tokenRefreshFunction = createOidcTokenRefreshFn(account);
	return createClient({
		baseUrl: account.homeserverUrl,
		accessToken: account.accessToken,
		userId: account.userId,
		deviceId: account.deviceId,
		// An account that has not been running has, by definition, a stale access
		// token - which for an OAuth2 (MSC3861) session is the routine case, and
		// the reason its refresh token is persisted at all. Without these the
		// revoke below 401s and the device survives on the server, still listed
		// and still push-capable, after Crust has thrown the credentials away.
		// BOTH are needed: the function has nothing to present without the token.
		...(account.refreshToken !== undefined
			? { refreshToken: account.refreshToken }
			: {}),
		...(tokenRefreshFunction !== undefined ? { tokenRefreshFunction } : {}),
	});
}

/**
 * Revoke `account`'s access token. Best-effort: a revoke that fails (an expired
 * credential, a server that is down) must not block the caller, which is either
 * discarding the credential anyway or has nowhere to retry from. Reports to the
 * console only - the caller surfaces its own outcome.
 */
export async function revokeAccountToken(account: Session): Promise<void> {
	try {
		await revokeSession(createAccountClient(account));
	} catch (e) {
		reportError(e, {
			logLabel: `Failed to revoke the token for ${account.userId}`,
		});
	}
}

/**
 * Revoke `account`'s token, wipe its crypto store, and forget it.
 *
 * Best-effort on the network half, for the reason above: the user asked for the
 * account to be gone and retrying would need credentials we are about to
 * discard. Returns whether the account actually left this device - false only
 * when storage refused the write, in which case it is still listed but its
 * token has been revoked, so the caller must not route back into it.
 */
export async function logOutAccount(account: Session): Promise<boolean> {
	const client = createAccountClient(account);
	try {
		await revokeSession(client);
	} catch (e) {
		reportError(e, {
			logLabel: `Failed to revoke the token for ${account.userId}`,
		});
	}
	try {
		// Bounded, like the foreground logout's wipe: `deleteDatabase` BLOCKS
		// while another window still has that account's store open and the SDK's
		// handler only logs it, so the promise never settles - and this runs
		// under the switcher's single-flight guard, which would then stay set for
		// the life of the module and lock out switching, adding and logging out.
		await withTimeout(
			clearCryptoStores(client, account),
			CRYPTO_INIT_TIMEOUT_MS,
			"Account store wipe",
		);
	} catch (e) {
		reportError(e, {
			logLabel: `Failed to clear the crypto store for ${account.userId}`,
		});
	}
	return removeAccount(account.userId);
}
