import { type Accessor, createSignal } from "solid-js";
import type { LivekitRoomApi } from "./useLivekitRoom";
import type { RtcSessionApi } from "./useRtcSession";

/**
 * Live API surface published by `CallSessionController` after its hooks
 * are constructed. `null` while no call is active (controller unmounted).
 *
 * The controller owns the lifecycle; chrome (`FullCallOverlay`,
 * `MiniCallWidget`) reads from this store to render and routes user
 * actions back through it. Keep this surface small — anything not used
 * by chrome should stay internal to the controller.
 */
export interface CallSessionApi {
	/** Monotonically-increasing controller instance id — used by the
	 * controller's `onCleanup` to avoid clobbering a fresh controller's
	 * publication during the switch flow (old unmounts, new mounts,
	 * old's cleanup runs after new's mount). */
	instanceId: number;
	/** Stable room id of the active call. */
	roomId: string;
	/** Resolved display name for the active call's room. */
	roomName: Accessor<string>;
	rtc: RtcSessionApi;
	livekit: LivekitRoomApi;
	/** True while the E2EE bridge build is in flight. */
	bridgeInitializing: Accessor<boolean>;
	/** Last E2EE bridge build error, cleared on the next attempt. */
	bridgeInitError: Accessor<Error | null>;
	/** True while a leave is in flight (after the user clicked Leave). */
	leaving: Accessor<boolean>;
	/**
	 * Build the E2EE bridge if not already present, then call rtc.join().
	 * Wraps the Phase-4 invariant of "bridge before join" inside the
	 * controller so chrome only sees a single async entry point.
	 */
	requestJoin: () => Promise<void>;
	/**
	 * Open the leave-confirmation dialog (or no-op when the session is
	 * already idle/leaving). The dialog and its actual leave path are
	 * owned by the controller so they survive route changes.
	 */
	requestClose: () => void;
	/**
	 * Direct-leave path used by the explicit "Leave call" button. On
	 * failure the controller opens the confirm dialog with the error
	 * surfaced inside it, then re-throws so callers can choose to react.
	 */
	requestLeave: () => Promise<void>;
}

const [currentSession, setCurrentSessionSignal] =
	createSignal<CallSessionApi | null>(null);

/** Reactive accessor: the live call session API or `null`. */
export const currentCallSession = currentSession;

let nextInstanceId = 1;

/** Allocate a new controller instance id. */
export function allocCallSessionInstanceId(): number {
	return nextInstanceId++;
}

/**
 * Publish (or update) the current controller's API. Should only be
 * called by `CallSessionController` itself.
 */
export function publishCallSession(api: CallSessionApi): void {
	setCurrentSessionSignal(api);
}

/**
 * Clear the published API only if the currently-published instance id
 * matches `instanceId`. Used by the controller's `onCleanup` to avoid
 * wiping a fresh controller's publication (e.g. during a switch flow
 * where the new controller mounts before the old controller's cleanup
 * runs).
 */
export function clearCallSessionIfCurrent(instanceId: number): void {
	const cur = currentSession();
	if (cur && cur.instanceId === instanceId) {
		setCurrentSessionSignal(null);
	}
}

/** Test helper — unconditionally clears the published API. */
export function _resetCallSessionForTests(): void {
	setCurrentSessionSignal(null);
	nextInstanceId = 1;
}
