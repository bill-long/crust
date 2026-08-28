import type { AuthDict, MatrixClient } from "matrix-js-sdk";
import { parseUia401, passwordAuthDict, pickUiaRoute } from "../lib/uia";

/**
 * Password-UIA-gated account security calls (#451): change password and
 * deactivate account. Both endpoints demand the ACCOUNT password via UIA,
 * which only password sessions can supply - Continuwuity refuses these
 * routes outright for OAuth sessions, whose management lives at the
 * account-management page instead (`fetchAccountManagementUrl`). The
 * dialogs collect the current password up front, so the UIA dance here is
 * non-interactive: request, take the 401's session, resubmit with the
 * password.
 */

const NO_PASSWORD_FLOW_MESSAGE =
	"This server does not accept a password to confirm this action from this app.";

/**
 * Run `request` through the password-UIA dance: try without auth, then
 * answer an `m.login.password` challenge with `password`. A challenge
 * offering no password flow fails with a clear message; a wrong password
 * surfaces as the server's own error.
 */
async function withPasswordUia(
	client: MatrixClient,
	password: string,
	request: (auth: AuthDict | undefined) => Promise<unknown>,
): Promise<void> {
	try {
		await request(undefined);
		return;
	} catch (e) {
		const uia = parseUia401(e);
		if (!uia) throw e;
		if (pickUiaRoute(uia.flows)?.kind !== "password") {
			throw new Error(NO_PASSWORD_FLOW_MESSAGE);
		}
		await request(
			passwordAuthDict(client.getUserId() ?? "", password, uia.session),
		);
	}
}

/**
 * Change the account password (`POST /account/password`).
 * `logoutOtherDevices: false` keeps every other session (and its
 * encryption state) alive, like Element's "Sign out all devices" toggle;
 * true invalidates them.
 */
export async function changePassword(
	client: MatrixClient,
	opts: {
		currentPassword: string;
		newPassword: string;
		logoutOtherDevices: boolean;
	},
): Promise<void> {
	await withPasswordUia(client, opts.currentPassword, (auth) =>
		// setPassword's typing demands an auth dict, but the UIA discovery
		// attempt must go out without one (the impl drops undefined).
		client.setPassword(
			auth as AuthDict,
			opts.newPassword,
			opts.logoutOtherDevices,
		),
	);
}

/**
 * Permanently deactivate the account (`POST /account/deactivate`).
 * `erase` requests best-effort removal of the account's messages from the
 * server. The caller signs the user out locally on success - the server
 * has already invalidated every token.
 */
export async function deactivateAccount(
	client: MatrixClient,
	opts: { password: string; erase: boolean },
): Promise<void> {
	await withPasswordUia(client, opts.password, (auth) =>
		client.deactivateAccount(auth, opts.erase),
	);
}

/** A third-party identifier bound to the account (`GET /account/3pid`). */
export interface ThreePid {
	medium: string;
	address: string;
}

/**
 * The account's bound third-party identifiers. Read-only: the server
 * capability `m.3pid_changes` governs mutation, which Crust doesn't offer
 * yet (#451 scopes the list first).
 */
export async function fetchThreePids(
	client: MatrixClient,
): Promise<ThreePid[]> {
	const res = (await client.getThreePids()) as { threepids?: unknown };
	if (!Array.isArray(res.threepids)) return [];
	return res.threepids.filter(
		(t): t is ThreePid =>
			typeof (t as ThreePid)?.medium === "string" &&
			typeof (t as ThreePid)?.address === "string",
	);
}
