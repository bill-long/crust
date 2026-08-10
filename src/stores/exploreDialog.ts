import { createSignal } from "solid-js";

/**
 * Cross-component request to open the public-room-directory dialog
 * (Explore). Written by the room list's "Explore public rooms" button;
 * consumed by `Layout`, which keeps the dialog mounted for the whole
 * session (RoomList unmounts on mobile while a room is open, so the
 * dialog can't live there - same reason the join dialog is hosted in
 * Layout).
 */

const [exploreDialogOpen, setExploreDialogOpen] = createSignal(false);

export { exploreDialogOpen };

/** Ask for the directory dialog to open. */
export function requestExploreDialog(): void {
	setExploreDialogOpen(true);
}

/** Close the directory dialog. */
export function closeExploreDialog(): void {
	setExploreDialogOpen(false);
}

/** Test-only: reset the signal between tests. */
export function _resetExploreDialogForTests(): void {
	setExploreDialogOpen(false);
}
