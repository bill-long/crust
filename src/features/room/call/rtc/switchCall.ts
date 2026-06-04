import { setActiveCallRoomId } from "../../../../stores/activeCall";
import { currentCallSession } from "./callSessionStore";

/**
 * Cross-room call switch orchestrator (Phase 7B PR B-2c of #122).
 * Used by `CallButton` when the user clicks Start/Join in a room
 * different from the currently-active call's room. Tears down the
 * current MatrixRTC session, then flips the global `activeCallRoomId`
 * to the target room.
 *
 * Does NOT auto-join the new room — the new controller mounts and the
 * overlay's existing Join button continues to be the explicit join
 * trigger, matching the start-a-call UX. Auto-joining the new room
 * would require coordinating with the new controller's
 * `publishCallSession` handshake; for symmetry with the existing
 * Start-a-call flow we let the overlay surface the Join button.
 *
 * Race protection: a module-level epoch counter is bumped on entry.
 * If a second `switchCall` invocation supersedes the first while the
 * first is still awaiting the leave, the older invocation observes
 * its epoch is stale and bails before mutating `activeCallRoomId`.
 * This keeps the latest user intent winning when the user rapid-fires
 * switch confirmations across multiple rooms.
 *
 * Pure helper (reads module-level signals + epoch only); safe to call
 * from outside reactive scopes. Tests reset state via
 * `_resetSwitchCallEpochForTests`.
 */
let switchEpoch = 0;

export interface SwitchCallResult {
	ok: boolean;
	/** True when the leave on the previous call rejected. The original
	 * call remains active; the controller's own ConfirmDialog has
	 * been re-opened with the error inside it. */
	leaveFailed?: boolean;
	/** True when a later `switchCall` invocation superseded this one. */
	superseded?: boolean;
	error?: Error;
}

export async function switchCall(
	targetRoomId: string,
): Promise<SwitchCallResult> {
	const myEpoch = ++switchEpoch;
	const session = currentCallSession();

	if (!session) {
		// No active call — just point the global signal at the target.
		// No await on this path, so no epoch race window exists.
		setActiveCallRoomId(targetRoomId);
		return { ok: true };
	}

	if (session.roomId === targetRoomId) {
		// Already pointing at target — nothing to do.
		return { ok: true };
	}

	try {
		// `requestLeave` is an awaitable single-flight inside the
		// controller. Concurrent callers (including a second
		// `switchCall` from a rapid user click) await the same in-flight
		// promise, so the epoch check below sees the real completion
		// state instead of returning prematurely.
		await session.requestLeave();
	} catch (err) {
		return {
			ok: false,
			leaveFailed: true,
			error: err instanceof Error ? err : new Error(String(err)),
		};
	}

	if (myEpoch !== switchEpoch) {
		// A later `switchCall` superseded ours after the leave settled.
		// Do not clobber the latest target with our stale one — the
		// later invocation is responsible for setting `activeCallRoomId`.
		return { ok: false, superseded: true };
	}

	setActiveCallRoomId(targetRoomId);
	return { ok: true };
}

/** Test helper — resets module-level state between tests. */
export function _resetSwitchCallEpochForTests(): void {
	switchEpoch = 0;
}
