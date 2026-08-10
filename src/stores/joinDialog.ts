import { createSignal } from "solid-js";
import type { JoinAddress } from "../lib/joinAddressParsing";

/**
 * Cross-component request to open the join-room dialog. Written by the
 * permalink router (a matrix.to room link to a room the user hasn't
 * joined) and by the room list's "Join a room" button; consumed by
 * `JoinRoomDialogHost`, which `Layout` keeps mounted for the whole session
 * (RoomList unmounts on mobile while a room is open, so the dialog can't
 * live there).
 */

export interface JoinDialogRequest {
	/** Address to prefill (permalink routing), or null for a blank manual open. */
	prefill: JoinAddress | null;
	/**
	 * Open with the knock offer pre-engaged (space discovery's Request
	 * button - the room is known knock-rule, so skip the doomed join
	 * attempt and show the reason field immediately).
	 */
	knockOffered?: boolean;
	/**
	 * Marks the prefill target as a space. Only space discovery knows
	 * this for certain (from the hierarchy's room_type); used so the
	 * optimistic knocked/joined stub surfaces in the spaces sidebar
	 * instead of Home's room lists until /sync delivers the
	 * authoritative m.room.create (#443).
	 */
	isSpace?: boolean;
}

const [joinDialogRequest, setJoinDialogRequest] =
	createSignal<JoinDialogRequest | null>(null);

export { joinDialogRequest };

/**
 * Ask for the join-room dialog to open, optionally prefilled with an
 * address. A request that arrives while the dialog is already open is
 * swallowed: the modal blocks the link clicks that produce requests, and
 * the open dialog only reads the prefill on its closed -> open transition.
 */
export function requestJoinDialog(
	prefill: JoinAddress | null = null,
	options?: { knockOffered?: boolean; isSpace?: boolean },
): void {
	setJoinDialogRequest({
		prefill,
		knockOffered: options?.knockOffered,
		isSpace: options?.isSpace,
	});
}

/** Clear the pending request (the dialog closed). */
export function clearJoinDialogRequest(): void {
	setJoinDialogRequest(null);
}

/** Test-only: reset the signal between tests. */
export function _resetJoinDialogForTests(): void {
	setJoinDialogRequest(null);
}
