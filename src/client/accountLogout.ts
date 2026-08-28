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
 */
import { createClient } from "matrix-js-sdk";
import { createOidcTokenRefreshFn } from "../features/auth/oidcRefresh";
import { reportError } from "../lib/reportError";
import { removeAccount, type Session } from "../stores/session";
import { clearCryptoStores } from "./cryptoRecovery";

/** A throwaway client for `account`, never started. */
function clientFor(account: Session): ReturnType<typeof createClient> {
	return createClient({
		baseUrl: account.homeserverUrl,
		accessToken: account.accessToken,
		userId: account.userId,
		deviceId: account.deviceId,
		// An account that has not been running has, by definition, a stale access
		// token - which for an OAuth2 (MSC3861) session is the routine case, and
		// the reason its refresh token is persisted at all. Without this the
		// revoke below 401s and the device survives on the server, still listed
		// and still push-capable, after Crust has thrown the credentials away.
		tokenRefreshFunction: createOidcTokenRefreshFn(account),
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
		await clientFor(account).logout(true);
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
 * discard. The local half always runs, so the account and its data leave this
 * device either way.
 */
export async function logOutAccount(account: Session): Promise<void> {
	const client = clientFor(account);
	try {
		await client.logout(true);
	} catch (e) {
		reportError(e, {
			logLabel: `Failed to revoke the token for ${account.userId}`,
		});
	}
	try {
		await clearCryptoStores(client, account);
	} catch (e) {
		reportError(e, {
			logLabel: `Failed to clear the crypto store for ${account.userId}`,
		});
	}
	removeAccount(account.userId);
}
