import {
	activeCallRoomId,
	setActiveCallRoomId,
} from "../../../../stores/activeCall";
import { currentCallSession } from "./callSessionStore";

/**
 * Upper bound on how long a caller waits for the call teardown before giving up
 * and proceeding.
 *
 * `requestLeave()` is NOT self-bounding: only its `rtc.leave()` step carries a
 * timeout (5s, via `leaveRoomSession`); the `livekit.disconnect()` step ahead of
 * it ends in a bare `await room.disconnect()`, which can stall indefinitely on a
 * wedged socket.
 *
 * Both callers need the cap, for different reasons. Unbounded, a flaky network
 * would block the room leave itself — and, in `Layout.performLeave`, its
 * `finally` too, pinning the room in the "leaving" state until a reload. On the
 * logout path it would instead leave the user unable to sign out; that button is
 * gated on a pending state, so the cap is also what bounds how long it stays
 * disabled. Typical real cost is ~300ms; this only bites when media is wedged.
 */
const TEARDOWN_TIMEOUT_MS = 10_000;

/**
 * Single call-teardown rule for every path that ends the user's access to the
 * room hosting a live call — leaving it (#435/#436/#437) or logging out (#474).
 *
 * Callers MUST await this before the request that revokes that access
 * (`client.leave(roomId)`, `client.logout()`).
 *
 * ## Why teardown-before-leave, and why awaited
 *
 * Withdrawing our MatrixRTC membership is a `m.call.member` state-event write,
 * so the server rejects it once we can no longer write to that room —
 * `M_FORBIDDEN` after a leave, `M_UNKNOWN_TOKEN` after a logout. Revoking
 * access first therefore strands the membership and every other participant
 * keeps seeing us in the call until it expires.
 *
 * Merely clearing `activeCallRoomId` before the leave is not enough: that only
 * unmounts `CallSessionController`, whose `onCleanup` fires the withdrawal
 * without awaiting it, and `MembershipManager.leave()` does not write the state
 * event synchronously — it wakes an async scheduler. The revoking request —
 * `client.leave()` or `client.logout()` — is issued in the current tick and wins
 * that race. Awaiting `requestLeave()` is what makes
 * the ordering real, because it awaits `leaveRoomSession()` all the way down.
 *
 * ## Accepted trade-off
 *
 * A `client.leave()` that fails *after* this resolves has ended a live call in
 * a room the user is still in. That is the deliberate choice: it is rare and
 * recoverable (rejoin the call), whereas the alternative ordering strands the
 * membership on **every** leave-while-in-a-call. Do not reintroduce a
 * success-gated variant of this rule without revisiting #435.
 *
 * The logout caller pays the same price in a different currency: a
 * `client.logout()` that throws is caught by `Layout.handleLogout`, which signs
 * the user out locally anyway — so a failed logout has also ended their call for
 * nothing. And logging out while in a call now waits for the teardown (typically
 * ~300ms, capped as above) instead of being instant. Both are worth it, because
 * the cost of getting it wrong is borne by *other* people: they keep seeing a
 * tile that will never speak.
 *
 * ## Residual, on the failure and timeout paths only
 *
 * When the teardown rejects or outruns `TEARDOWN_TIMEOUT_MS`, this clears
 * `activeCallRoomId` and returns so the room leave still happens. That unmounts
 * the controller, and `useRtcSession`'s `onCleanup` fires a fire-and-forget
 * withdrawal which then races `client.leave()` exactly as #435 describes — so on
 * those paths the membership may still be stranded. Retrying the withdrawal here
 * would not help: the rejection path has already awaited one `rtc.leave()` that
 * failed, and a second attempt would only delay the leave the user asked for.
 *
 * Resolves once the call is torn down, or immediately when `roomId` does not
 * host the active call. It rejects only through `setActiveCallRoomId`, which
 * runs its Solid subscribers synchronously: the stale-signal branch below writes
 * it outside the try, and the failure/timeout branch writes it from inside the
 * catch, so a throwing subscriber on either surfaces at the call site. Every
 * account-exit caller catches this for that reason; a teardown that has already
 * ended the user's call must not then abort the exit it was for.
 */
export async function endCallForRoomLeave(roomId: string): Promise<void> {
	if (activeCallRoomId() !== roomId) return;
	await endCall(roomId);
}

/**
 * Teardown before the session ends: ends whichever call is active, if any.
 *
 * Same rule and same bound as `endCallForRoomLeave` — only the trigger differs,
 * so the caller does not need to know which room hosts the call. Await this
 * before anything that ends the session: `client.logout()`, or the desktop
 * shell quitting to apply an update. See the module rationale above for why the
 * wait is what makes the withdrawal land.
 *
 * The forced-logout escape hatch (`app/forceLogout.ts`) is one of those callers
 * as of #551, having previously been the documented exception: it stopped the
 * client rather than logging out, so there was no revoking request to lose the
 * race to, and waiting looked like it could only wedge the way out. Both halves
 * of that changed. It now revokes, so it has a revoking request like everyone
 * else - and `logout(true)` aborts the client's in-flight requests before it
 * asks, so an unawaited withdrawal is not merely likely to lose that race, it is
 * cancelled outright. The wedge it worried about is answered by the bound above,
 * which is this module's to own: a caller that adds a second, shorter one is
 * back to stranding the membership.
 */
export async function endActiveCall(): Promise<void> {
	const roomId = activeCallRoomId();
	if (roomId === null) return;
	await endCall(roomId);
}

/** Shared teardown: `roomId` is known to be the active call's room. */
async function endCall(roomId: string): Promise<void> {
	const session = currentCallSession();
	if (!session || session.roomId !== roomId) {
		// The signal points at this room but no controller is published for
		// it (mid-mount, or a stale signal). Nothing awaitable to tear down;
		// drop the signal so the chrome doesn't outlive the room either.
		setActiveCallRoomId(null);
		return;
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// `requestLeave` is the controller's awaitable single-flight; on
		// success it clears `activeCallRoomId` itself, after every step of
		// the teardown has settled.
		await Promise.race([
			session.requestLeave(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`Call teardown timed out after ${TEARDOWN_TIMEOUT_MS}ms`,
							),
						),
					TEARDOWN_TIMEOUT_MS,
				);
			}),
		]);
	} catch (err) {
		// Teardown failed or timed out. On the failure path `requestLeave` has
		// opened the controller's leave-confirm dialog to surface the error,
		// but "Stay" is not a meaningful choice when the user is leaving the
		// room outright — clear the signal so the controller and its dialog
		// unmount, and let the leave proceed. See "Residual" above.
		console.error("Call teardown failed:", roomId, err);
		if (activeCallRoomId() === roomId) setActiveCallRoomId(null);
	} finally {
		clearTimeout(timer);
	}
}
