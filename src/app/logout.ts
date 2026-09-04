/**
 * The teardown that takes an account off this device (#551, #555).
 *
 * One sequence, two callers: the ordinary logout in `Layout`, and the escape
 * `SyncGate` offers from a boot or a sync this app cannot finish - the
 * sync-error screen, and the still-syncing one once the boot has stalled
 * (`bootStall.ts`). The escape replaced "type `/login`", which worked by
 * replacing the stored account and orphaning its device (#549); the ordinary
 * path used to carry its own copy of this sequence, which is the drift #555
 * closed. The third exit, the expired-session effect in `App`, runs only step
 * 4 below (the client is already stopped, and on a token the server has
 * invalidated there is no withdrawal, release or revoke left to land), and
 * enters it through the same `finishSessionExit` this one ends with (#601).
 *
 * It lives here rather than in a component for the reason `accountSwitch.ts`
 * does: what makes it correct is an ORDER, and an order that only exists inside
 * a JSX file has nowhere to be tested. Every step owes something to a server
 * this app is about to stop talking to, and each one has to happen while the
 * thing it needs is still true:
 *
 *  1. The MatrixRTC withdrawal, while the token can still write to the room.
 *  2. The push registration, while the token can still name it server-side.
 *  3. The revoke, which invalidates that token.
 *  4. The wipe and the clear, which need nothing from the network at all.
 *
 * Two properties hold across all of it. Every step is BOUNDED, because a
 * logout must never hang - and the bound for each lives with the rule it
 * belongs to, never duplicated here: the call teardown's is
 * `TEARDOWN_TIMEOUT_MS`, the push release's `PUSH_REQUEST_TIMEOUT_MS`, the
 * revoke's `REVOKE_TIMEOUT_MS` (in `client/accountLogout.ts`, shared with the
 * background-account logout), the wipe's `CRYPTO_INIT_TIMEOUT_MS`. They add
 * up: against a homeserver that answers nothing, every bound runs to expiry
 * and the user watches "Logging out…" for the better part of a minute. That
 * is the deliberate trade - each wait is there because skipping it strands
 * something on the server, and a logout that finishes slowly is still a
 * logout. And no step may abort the ones after it: a failure anywhere still
 * has to end with the account off this device, or the logout leaves exactly
 * the orphaned, still-push-capable device the escape exists to prevent -
 * described to the user as "signed out".
 */

import type { MatrixClient } from "matrix-js-sdk";
import { revokeSession } from "../client/accountLogout";
import { clearCryptoStores } from "../client/cryptoRecovery";
import { disableBackgroundNotifications } from "../features/notifications/accountPush";
import { closeNotificationSound } from "../features/room/notificationSound";
import { reportError } from "../lib/reportError";
import { setActiveCallRoomId } from "../stores/activeCall";
import type { Session } from "../stores/session";
import type { PushConfig } from "../types/config";
import { finishAccountLogout } from "./accountSwitch";
import { quiesceLiveSession } from "./quiesceSession";

export interface LogoutOptions {
	/** The running client, still holding this account's token. */
	client: MatrixClient;
	/** Operator push config, for handing back the device's registration. */
	pushConfig: PushConfig;
	/** The account on screen - never "whoever storage calls active" (#532). */
	session: Session;
	/** Route to the login page; only reached when no account remains. */
	goToLogin: () => void;
}

/**
 * Leave the account this document is running.
 *
 * Returns "reloading" when a remaining account is being loaded into, which means
 * the document is being replaced and nothing after it is guaranteed to run - a
 * caller holding a single-flight guard must KEEP it set (see `accountSwitch.ts`,
 * invariant 1).
 */
export async function runLogout(
	opts: LogoutOptions,
): Promise<"reloading" | "left"> {
	const { client, pushConfig } = opts;
	// Steps 1a-1b, shared with the account switch (`quiesceSession.ts`): the
	// chime, then the call teardown while this token can still write to the
	// room, then the global call signal.
	await quiesceLiveSession("on the way out");
	// While the token is still valid, and before `finishAccountLogout` clears the
	// account the preference is filed under (#534): a pusher can only be removed
	// server-side by a credential that still works. Bounded in its own right.
	//
	// Every step of this teardown is caught, not just the ones that look
	// fragile: the invariant is that no step may abort the ones after it, and a
	// per-step argument about which can throw is exactly what decays. This one
	// writes a Solid setting before its own try, and those subscribers run
	// synchronously.
	try {
		await disableBackgroundNotifications(client, pushConfig);
	} catch (e) {
		reportError(e, {
			logLabel: "Could not release background notifications on the way out",
		});
	}
	try {
		// Bounded, best-effort revoke that outlives the document (see
		// `revokeSession`). The escape used to skip revoking, on the grounds
		// that the connection was already broken - but a stall is one endpoint
		// hanging, not a server that is gone, so the revoke usually lands.
		// Skipping it leaves precisely what #549 exists to prevent: a device
		// still alive and push-capable on the homeserver with no UI left to
		// reach it, described to the user as "signed out".
		await revokeSession(client);
	} catch (e) {
		// The client is stopped regardless: `revokeSession` runs
		// `stopClientFully` before the request, and that never throws.
		reportError(e, {
			logLabel: "Could not revoke this session on the way out",
		});
	}
	return await finishSessionExit(opts);
}

/**
 * The part of the teardown that needs nothing from the network: quiet the
 * per-account surfaces once more, then take the account off this device.
 *
 * Two callers, and the second is why this is exported. `runLogout` reaches it
 * after the network steps, which take a bounded but real while - long enough
 * for a call to have been started behind the screen, which is why the signal
 * is cleared again here rather than only in the prefix. The expired-session
 * effect in `App` enters HERE, because on a token the server has already
 * invalidated there is no withdrawal, release or revoke left to land - it used
 * to assemble these same two steps by hand, in the same order, with nothing
 * holding them to it and no test (#601).
 *
 * The chime and the signal, not `quiesceLiveSession`: ending the call properly
 * is a network step, and on an expired session it would only spend
 * `TEARDOWN_TIMEOUT_MS` failing to reach a server that has stopped listening.
 */
export async function finishSessionExit(
	opts: LogoutOptions,
): Promise<"reloading" | "left"> {
	const { client, pushConfig, session } = opts;
	// Caught like every other write to it: a Solid setter runs its subscribers
	// synchronously, and a throwing effect here would abort the wipe and the
	// clear - leaving an account still on this device with no UI to reach it.
	try {
		setActiveCallRoomId(null);
	} catch (e) {
		reportError(e, {
			logLabel: "Could not clear the active call while ending the session",
		});
	}
	closeNotificationSound();
	// `finishAccountLogout` owns the rest: the (bounded) wipe finishes before
	// anything navigates, so replacing the document cannot abort the delete. That
	// is why the caller's screen has to stay up while this runs.
	return await finishAccountLogout(
		{ client, pushConfig },
		session.userId,
		// Best-effort, and bounded and caught inside `finishAccountLogout`: the
		// account is leaving this device either way.
		() => clearCryptoStores(client, session),
		opts.goToLogin,
	);
}
