import {
	activeCallRoomId,
	setActiveCallRoomId,
} from "../../../../stores/activeCall";
import { currentCallSession } from "./callSessionStore";

/**
 * Upper bound on how long a room leave waits for its call teardown.
 *
 * `requestLeave()` is NOT self-bounding: only its `rtc.leave()` step carries a
 * timeout (5s, via `leaveRoomSession`); the `livekit.disconnect()` step ahead of
 * it ends in a bare `await room.disconnect()`, which can stall indefinitely on a
 * wedged socket. Leaving that unbounded would let a flaky network block the room
 * leave itself — and, in `Layout.performLeave`, its `finally` too, pinning the
 * room in the "leaving" state until a reload. So the wait is capped here and the
 * leave proceeds regardless.
 */
const TEARDOWN_TIMEOUT_MS = 10_000;

/**
 * Single call-teardown rule for every "leave this room" path (#435/#436/#437).
 *
 * Callers MUST await this before `client.leave(roomId)`.
 *
 * ## Why teardown-before-leave, and why awaited
 *
 * Withdrawing our MatrixRTC membership is a `m.call.member` state-event write,
 * so the server rejects it with `M_FORBIDDEN` once we are no longer joined to
 * the room. Leaving first therefore strands the membership and every other
 * participant keeps seeing us in the call until it expires.
 *
 * Merely clearing `activeCallRoomId` before the leave is not enough: that only
 * unmounts `CallSessionController`, whose `onCleanup` fires the withdrawal
 * without awaiting it, and `MembershipManager.leave()` does not write the state
 * event synchronously — it wakes an async scheduler. `client.leave()`, issued
 * in the current tick, wins that race. Awaiting `requestLeave()` is what makes
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
 * Resolves (never rejects) once the call is torn down, or immediately when
 * `roomId` does not host the active call.
 */
export async function endCallForRoomLeave(roomId: string): Promise<void> {
	if (activeCallRoomId() !== roomId) return;

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
		console.error("Call teardown before room leave failed:", roomId, err);
		if (activeCallRoomId() === roomId) setActiveCallRoomId(null);
	} finally {
		clearTimeout(timer);
	}
}
