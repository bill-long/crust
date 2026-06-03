import { createSignal } from "solid-js";

/**
 * Global active-call state (Phase 7B of #122 — closes #99 bullets 2 & 4).
 *
 * Holds the room id of the currently-active MatrixRTC call session, or
 * `null` when no call is open. Set when the user clicks Start/Join in the
 * room header; cleared after a successful leave or on logout.
 *
 * Hoisted out of `RoomPane` (which is keyed on the route's roomId and
 * thus unmounts on navigation) so the LiveKit Room and MatrixRTC session
 * survive route changes. In PR B-1 the `FullCallOverlay` is gated on
 * `activeCallRoomId() === routeRoomId`, so navigating away simply
 * unmounts the overlay chrome while the hoisted `CallSessionController`
 * keeps the session alive; navigating back re-mounts the overlay
 * against the same live session (no rejoin). PR B-2 will add a
 * `MiniCallWidget` that renders while away to expose the call.
 *
 * Single-call invariant: the call surface (`FullCallOverlay`, plus
 * `MiniCallWidget` in a follow-up PR) is driven entirely off
 * `activeCallRoomId()`, so only one MatrixRTC session can be live at a
 * time. In PR B-1 the `CallButton` enforces this by refusing to start
 * a new call while one is active in a different room (the user must
 * leave the current call first); PR B-2 will replace that with a
 * confirm-dialog handoff that awaits the old controller's leave path
 * before flipping this signal to the new room id.
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
