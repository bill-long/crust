/**
 * The three steps that quiet a LIVE session's per-account surfaces before it
 * stops being the session on screen (#601).
 *
 * Two exits share them byte for byte today - the logout in `logout.ts` and
 * the account switch in `accountSwitch.ts` - and each copy's comment cited
 * the other as its rationale, which is the drift this closes: the next
 * per-account singleton that has to be quieted (a picture-in-picture window,
 * a new `endCall` branch) belongs here, where both callers get it.
 *
 * It is its own module rather than a function in either caller: `logout.ts`
 * already imports `accountSwitch.ts` for the tail, so the shared step cannot
 * live there without a cycle, and `logout.test.ts` replaces the whole
 * `accountSwitch` module - a helper hidden behind that mock would be
 * untestable from the side that needs it most.
 *
 * What does NOT belong here is the step after these, which differs by exit
 * and legitimately so: a switch hands the push registration back
 * (`releaseWebPush`), a logout disables it outright
 * (`disableBackgroundNotifications`).
 */

import { endActiveCall } from "../features/room/call/rtc/endCall";
import { closeNotificationSound } from "../features/room/notificationSound";
import { reportError } from "../lib/reportError";
import { setActiveCallRoomId } from "../stores/activeCall";

/**
 * Quiet this account's call and sound surfaces, in the order that makes each
 * step still true when it runs.
 *
 * `context` is the tail of the log labels ("on the way out", "while leaving
 * the account"), so a failure still says which exit it came from.
 *
 * Every step is caught, and the reason is one rule rather than a per-step
 * argument about which of them can throw: no step may abort the ones after
 * it. An exit that has already ended the user's call must not then leave the
 * account alive on this device - and the two writes here are exactly the
 * kind that can surface someone else's failure, because `endActiveCall`
 * clears the call signal on one branch outside its own try and a Solid
 * setter runs its subscribers synchronously.
 */
export async function quiesceLiveSession(context: string): Promise<void> {
	// The chime first: a message arriving mid-exit must not sound into the
	// account being left, and the steps below can take a bounded while.
	// Caught like the rest - the rule is that no step may abort the ones
	// after it, and this one runs before the withdrawal that has a deadline.
	try {
		closeNotificationSound();
	} catch (e) {
		reportError(e, { logLabel: `Could not stop the chime ${context}` });
	}
	// The MatrixRTC withdrawal has to reach the server while this token can
	// still write to the room (#474). A call can be live behind any screen
	// these exits run from - `PersistentCallSurface` is a sibling of the
	// sync-state switch, so even a sync error has not ended one. Dropping the
	// signal alone only SCHEDULES the withdrawal on unmount, which a logout's
	// revoke then cancels outright with `http.abort()`, leaving the user a
	// ghost participant until the membership expires.
	//
	// Bounded by `endCall` itself (TEARDOWN_TIMEOUT_MS), not here: the bound
	// belongs with the rule it enforces.
	try {
		await endActiveCall();
	} catch (e) {
		reportError(e, { logLabel: `Could not end the call ${context}` });
	}
	// `endActiveCall` clears the signal only for the room it tore down, and the
	// signal is module-global and never reset on login: a call started during
	// the teardown would otherwise outlive this session and be inherited by the
	// next account on this tab, with the mini-widget or overlay pointing at a
	// client that is about to stop.
	try {
		setActiveCallRoomId(null);
	} catch (e) {
		reportError(e, { logLabel: `Could not clear the active call ${context}` });
	}
}
