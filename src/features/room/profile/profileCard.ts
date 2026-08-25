import { createSignal } from "solid-js";

/**
 * Request to show the profile card for a user. One card exists app-wide
 * (`ProfileCardHost`, rendered by Layout); entry points - member-list
 * rows, timeline message headers, mention pills - open it through this
 * signal with the clicked element as the popover anchor.
 */
export interface ProfileCardRequest {
	userId: string;
	/**
	 * Room context for role + moderation actions and the Mention target.
	 * Null when the card is opened outside any room (a pill on a
	 * non-room route) - the card then shows profile + DM only.
	 */
	roomId: string | null;
	/** Thread-panel composer target for Mention; null = room composer. */
	threadRootId: string | null;
	/** Element the popover anchors to. */
	anchor: HTMLElement;
}

const [profileCardRequest, setProfileCardRequest] =
	createSignal<ProfileCardRequest | null>(null);

export { profileCardRequest };

// Clicking the element the open card is anchored to must TOGGLE it
// closed, not close-and-reopen. Kobalte's interact-outside dismiss fires
// on pointerdown - before the anchor's own click handler calls
// openProfileCard - so the just-dismissed anchor is remembered briefly
// and the same gesture's reopen is swallowed.
const DISMISS_TOGGLE_WINDOW_MS = 500;
let dismissedAnchor: HTMLElement | null = null;
let dismissedAt = 0;

export function openProfileCard(
	request: Omit<ProfileCardRequest, "threadRootId"> &
		Partial<Pick<ProfileCardRequest, "threadRootId">>,
): void {
	const current = profileCardRequest();
	if (current && current.anchor === request.anchor) {
		closeProfileCard();
		return;
	}
	if (
		dismissedAnchor === request.anchor &&
		Date.now() - dismissedAt < DISMISS_TOGGLE_WINDOW_MS
	) {
		dismissedAnchor = null;
		return;
	}
	setProfileCardRequest({ threadRootId: null, ...request });
}

export function closeProfileCard(): void {
	const current = profileCardRequest();
	if (current) {
		dismissedAnchor = current.anchor;
		dismissedAt = Date.now();
	}
	setProfileCardRequest(null);
}
