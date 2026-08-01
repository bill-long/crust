/**
 * Voice-channel join/leave cue gating (#431).
 *
 * Decides WHEN a presence cue should sound; `notificationSound.ts` owns the
 * actual synthesis. Split out of `useLivekitRoom.ts` (already ~1,475 lines)
 * so the gating rules - which carry all the subtlety here - get their own
 * focused test.
 *
 * The central decision: LiveKit participant events are treated purely as
 * "something changed, look again" triggers. Their payloads are ignored.
 * At flush time we re-read the authoritative remote-participant roster and
 * diff it against the last known set. Every edge case falls out of that
 * rather than needing its own guard:
 *
 * - A burst of joins collapses into one flush, so one cue.
 * - The local SESSION is never in `remoteParticipants`, so our own join and
 *   hangup are silent. Note this is per-session, not per-user: LiveKit
 *   identities are `<userId>:<deviceId>`, so a second device of the same
 *   Matrix user IS an ordinary remote participant and does cue. That matches
 *   the participant list, which shows that device as its own tile.
 * - Hangup disarms via `reset()` before `r.disconnect()` runs.
 * - Reconnect - the case that defeats per-event bookkeeping - is deferred by
 *   the liveness check, and crucially the known set is left UNTOUCHED while
 *   not live. livekit-client's `handleRestarting` emits
 *   `ParticipantDisconnected` for every remote participant before flipping
 *   to `Reconnecting`, then replays a buffered `ParticipantConnected` for
 *   each one after resuming. Because we never consumed those events, the
 *   post-reconnect roster diffs against the pre-reconnect set to nothing and
 *   an unchanged roster stays silent.
 *
 * Deferred, NOT dropped: a flush that finds the room not live re-opens the
 * window and keeps retrying until liveness returns (or `reset()` disarms).
 * Without that retry the stale baseline would sit unreconciled until some
 * unrelated later event happened to schedule a flush, so someone who left
 * during the outage would go unannounced and then surface as a phantom leave
 * cue attached to a much later, unrelated join.
 */

/** Coalescing window (ms). Folds a group join/leave into a single cue, and
 *  is long enough for a reconnect's state transition to land before we look.
 *  Doubles as the rate limit on cues, so the synthesis layer needs no
 *  debounce of its own. */
export const PRESENCE_COALESCE_MS = 250;

export interface PresenceCueDeps {
	/** Current remote participant identities. Excludes the local session. */
	roster: () => Iterable<string>;
	/** False while the room is absent, reconnecting, or otherwise not live. */
	isLive: () => boolean;
	/** Whether the user has the cue enabled. */
	enabled: () => boolean;
	/** Plays the coalesced cue(s). */
	play: (opts: { join: boolean; leave: boolean }) => void;
	/** Injected for tests. */
	setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface PresenceCue {
	/**
	 * Seed the known roster and enable cues. Called once the connection is
	 * established, so participants already present when we joined are known
	 * from the start and never announce themselves.
	 */
	arm: () => void;
	/** Note that the roster may have changed; starts the coalescing window. */
	schedule: () => void;
	/** Disarm and forget. Called from call-derived state reset. */
	reset: () => void;
}

export function createPresenceCue(deps: PresenceCueDeps): PresenceCue {
	const setTimer = deps.setTimer ?? setTimeout;
	const clearTimer = deps.clearTimer ?? clearTimeout;

	let known = new Set<string>();
	let armed = false;
	let pending: ReturnType<typeof setTimeout> | null = null;

	const cancelPending = (): void => {
		if (pending !== null) {
			clearTimer(pending);
			pending = null;
		}
	};

	const openWindow = (): void => {
		if (pending !== null) return; // window already open, let it run
		pending = setTimer(flush, PRESENCE_COALESCE_MS);
	};

	function flush(): void {
		pending = null;
		if (!armed) return;
		// Not live (mid-reconnect): leave `known` alone and try again next
		// window. Re-reading the roster here would bake the transient empty
		// roster into the baseline and make the recovery diff spuriously loud;
		// simply returning would strand the baseline until an unrelated event
		// re-opened a window. `reset()` ends this loop on teardown/drop.
		if (!deps.isLive()) {
			openWindow();
			return;
		}

		const current = new Set(deps.roster());
		let join = false;
		let leave = false;
		for (const id of current) {
			if (!known.has(id)) {
				join = true;
				break;
			}
		}
		for (const id of known) {
			if (!current.has(id)) {
				leave = true;
				break;
			}
		}
		known = current;

		if (!join && !leave) return;
		// The roster is still adopted above when the setting is off, so
		// re-enabling it mid-call doesn't replay everything that changed while
		// it was off as one spurious cue.
		if (!deps.enabled()) return;
		deps.play({ join, leave });
	}

	return {
		arm: (): void => {
			cancelPending();
			known = new Set(deps.roster());
			armed = true;
		},
		schedule: (): void => {
			if (!armed) return;
			openWindow();
		},
		reset: (): void => {
			cancelPending();
			known = new Set();
			armed = false;
		},
	};
}
