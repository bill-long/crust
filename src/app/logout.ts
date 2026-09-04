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
 * invalidated there is no withdrawal, release or revoke left to land) and
 * assembles it by hand; folding that in is #601.
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
import { endActiveCall } from "../features/room/call/rtc/endCall";
import { closeNotificationSound } from "../features/room/notificationSound";
import { reportError } from "../lib/reportError";
import { setActiveCallRoomId } from "../stores/activeCall";
import type { Session } from "../stores/session";
import type { PushConfig } from "../types/config";
import { finishAccountLogout } from "./accountSwitch";

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
	const { client, pushConfig, session } = opts;
	closeNotificationSound();
	// A call can be live behind any screen this runs from: the ordinary logout
	// is a menu item, and `PersistentCallSurface` is a sibling of the sync-state
	// switch, so a sync error does not end one either. The withdrawal has to
	// reach the server while this token can still write to the room (#474), and
	// the revoke below is about to invalidate it - dropping the signal alone
	// only SCHEDULES the withdrawal on unmount, which the revoke's
	// `http.abort()` then cancels outright, leaving the user a ghost participant
	// until the membership expires.
	//
	// Caught, though not bounded: `endCall` owns the bound, but it clears
	// `activeCallRoomId` on one branch OUTSIDE its own try, and a Solid setter
	// runs its subscribers synchronously - so a throwing effect surfaces here.
	// Aborting on the FIRST step would skip the release, the revoke and the wipe
	// and leave the account fully alive on this device - a teardown that has
	// already ended the user's call must not then leave them signed in. Same
	// reason `endSessionForAccountExit` catches it.
	try {
		await endActiveCall();
	} catch (e) {
		reportError(e, { logLabel: "Could not end the call on the way out" });
	}
	// `endActiveCall` clears the signal only for the room it tore down, and the
	// signal is module-global and never reset on login: a call started during
	// the teardown would otherwise outlive this session and be picked up by the
	// NEXT account to log in on this tab, with the mini-widget / overlay pointing
	// at a client that is about to stop.
	//
	// Caught for the same reason the call above it is, and it is the same
	// hazard rather than a similar one: this IS the setter whose subscribers run
	// synchronously, so when a call is live - the only time this write notifies
	// anything - a throwing effect would abort the three steps that take the
	// account off this device.
	try {
		setActiveCallRoomId(null);
	} catch (e) {
		reportError(e, {
			logLabel: "Could not clear the active call on the way out",
		});
	}
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
	// `finishAccountLogout` owns the tail: the (bounded) wipe finishes before
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
