/**
 * The way out of a boot or a sync this app cannot finish (#551).
 *
 * `SyncGate` offers this from two screens - the sync-error one, and the
 * still-syncing one once the boot has stalled (`bootStall.ts`) - and it is the
 * replacement for an escape that used to be "type `/login`", which worked by
 * replacing the stored account and orphaning its device (#549).
 *
 * It lives here rather than in the component for the reason `accountSwitch.ts`
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
 * Two properties hold across all of it. Every step is BOUNDED, because the way
 * out of a hang must never itself hang - and the bound for each lives with the
 * rule it belongs to, never duplicated here. And no step may abort the ones
 * after it: a failure anywhere still has to end with the account off this
 * device, or the escape leaves exactly the orphaned, still-push-capable device
 * it exists to prevent.
 */

import type { MatrixClient } from "matrix-js-sdk";
import { clearCryptoStores, withTimeout } from "../client/cryptoRecovery";
import { disableBackgroundNotifications } from "../features/notifications/accountPush";
import { endActiveCall } from "../features/room/call/rtc/endCall";
import { closeNotificationSound } from "../features/room/notificationSound";
import { reportError } from "../lib/reportError";
import { setActiveCallRoomId } from "../stores/activeCall";
import type { Session } from "../stores/session";
import type { PushConfig } from "../types/config";
import { finishAccountLogout } from "./accountSwitch";

/**
 * How long the escape waits for the token revoke before leaving without it.
 * Long enough for a server that is merely stalled on one endpoint to answer,
 * short enough that the way out of a hang is never itself a hang.
 *
 * The escape's other waits carry no bound from here - each is bounded where its
 * own rule lives: the call teardown by `TEARDOWN_TIMEOUT_MS`, the push release
 * by `PUSH_REQUEST_TIMEOUT_MS`, the store wipe by `CRYPTO_INIT_TIMEOUT_MS`. A
 * second bound here would only ever be the shorter of the two and would preempt
 * the real one.
 *
 * They do add up: against a homeserver that answers nothing - the case this
 * escape exists for - every bound runs to expiry and the user watches
 * "Logging out…" for the better part of a minute. That is the deliberate trade.
 * Each wait is there because skipping it strands something on the server, and
 * an escape that finishes slowly is still an escape; one that leaves a live
 * device behind is the bug this replaced.
 */
export const FORCE_LOGOUT_REVOKE_TIMEOUT_MS = 5_000;

export interface ForceLogoutOptions {
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
 * Leave the account this document is running, from a screen where the app never
 * finished starting.
 *
 * Returns "reloading" when a remaining account is being loaded into, which means
 * the document is being replaced and nothing after it is guaranteed to run - a
 * caller holding a single-flight guard must KEEP it set (see `accountSwitch.ts`,
 * invariant 1).
 */
export async function runForceLogout(
	opts: ForceLogoutOptions,
): Promise<"reloading" | "left"> {
	const { client, pushConfig, session } = opts;
	closeNotificationSound();
	// A call can be live behind either screen this is offered from:
	// `PersistentCallSurface` is a sibling of the sync-state switch, so a sync
	// error does not end one. The withdrawal has to reach the server while this
	// token can still write to the room (#474), and the revoke below is about to
	// invalidate it - dropping the signal alone only SCHEDULES the withdrawal on
	// unmount, which `logout(true)`'s `http.abort()` then cancels outright,
	// leaving the user a ghost participant until the membership expires.
	//
	// Caught, though not bounded: `endCall` owns the bound, but it clears
	// `activeCallRoomId` on one branch OUTSIDE its own try, and a Solid setter
	// runs its subscribers synchronously - so a throwing effect surfaces here.
	// Aborting on the FIRST step would skip the release, the revoke and the wipe
	// and leave the account fully alive on this device, which is the one outcome
	// this whole path exists to avoid. Same reason `endSessionForAccountExit`
	// catches it.
	try {
		await endActiveCall();
	} catch (e) {
		reportError(e, { logLabel: "Could not end the call on the way out" });
	}
	// `endActiveCall` clears the signal only for the room it tore down, and the
	// signal is module-global: a call started during the teardown would otherwise
	// outlive this session, with the mini-widget / overlay pointing at a client
	// that is about to stop.
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
		// Bounded, best-effort revoke. This escape used to skip revoking, on the
		// grounds that the connection was already broken - but a stall is one
		// endpoint hanging, not a server that is gone, so the revoke usually
		// lands. Skipping it leaves precisely what #549 exists to prevent: a
		// device still alive and push-capable on the homeserver with no UI left to
		// reach it, described to the user as "signed out".
		await withTimeout(
			client.logout(true),
			FORCE_LOGOUT_REVOKE_TIMEOUT_MS,
			"Force logout revoke",
		);
	} catch (e) {
		reportError(e, {
			logLabel: "Could not revoke this session on the way out",
		});
		// Idempotent, and normally already done: `logout(true)` stops the client
		// and aborts its in-flight requests before it asks. This covers the case
		// where it never got that far.
		client.stopClient();
	}
	// `finishAccountLogout` owns the tail: the (bounded) wipe finishes before
	// anything navigates, so replacing the document cannot abort the delete. That
	// is why the caller's screen has to stay up while this runs.
	return await finishAccountLogout(
		{ client, pushConfig },
		session.userId,
		async () => {
			try {
				await clearCryptoStores(client, session);
			} catch {
				// Best-effort: the account is leaving this device either way, and
				// `finishAccountLogout` bounds this wait.
			}
		},
		opts.goToLogin,
	);
}
