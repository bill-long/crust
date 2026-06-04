import { createSignal } from "solid-js";

/**
 * Global active-call state.
 *
 * Holds the room id of the currently-active MatrixRTC call session, or
 * `null` when no call is open. Set when the user clicks Start/Join in the
 * room header; cleared after a successful leave or on logout.
 *
 * Hoisted out of `RoomPane` (which is keyed on the route's roomId and
 * thus unmounts on navigation) so the LiveKit Room and MatrixRTC session
 * survive route changes. The `FullCallOverlay` is gated on
 * `activeCallRoomId() === routeRoomId`, so navigating away simply
 * unmounts the overlay chrome while the persistent `CallSessionController`
 * (mounted in `PersistentCallSurface` above the per-route `Layout`)
 * keeps the session alive; navigating back re-mounts the overlay
 * against the same live session (no rejoin). The `MiniCallWidget`,
 * also mounted in `PersistentCallSurface`, renders while the user is
 * viewing a different room and exposes a "Return to call" affordance.
 *
 * Single-call invariant: the call surface (`FullCallOverlay` +
 * `MiniCallWidget`) is driven entirely off `activeCallRoomId()`, so
 * only one MatrixRTC session can be live at a time. `CallButton`
 * enforces this by refusing to start a new call while one is active
 * in a different room (the user must leave the current call first).
 */
const [activeRoomIdSignal, setActiveRoomIdSignal] = createSignal<string | null>(
	null,
);

export function activeCallRoomId(): string | null {
	return activeRoomIdSignal();
}

export function setActiveCallRoomId(roomId: string | null): void {
	setActiveRoomIdSignal(roomId);
}

/** Test helper — resets module-level state between tests. */
export function _resetActiveCallForTests(): void {
	setActiveRoomIdSignal(null);
}
