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
	/**
	 * Element the popover anchors to. MUTABLE: when a member-list row
	 * re-mints, the open popover re-resolves to the new element and
	 * writes it back here, so the toggle-close comparison below always
	 * sees the live anchor.
	 */
	anchor: HTMLElement;
}

const [profileCardRequest, setProfileCardRequest] =
	createSignal<ProfileCardRequest | null>(null);

export { profileCardRequest };

/**
 * Value for a `data-profile-anchor` attribute on an entry-point element
 * whose row can be re-minted while the card is open (the member list).
 * The open card re-resolves its anchor to the re-minted element by this
 * key instead of closing. Space-separated: Matrix IDs cannot contain
 * spaces, and the value must survive `CSS.escape` + `querySelector`
 * round-trips byte-for-byte.
 */
export function profileAnchorKey(
	roomId: string | null,
	userId: string,
): string {
	return `${roomId ?? ""} ${userId}`;
}

/**
 * Open the card - or, when the click landed on the element the open
 * card is already anchored to, TOGGLE it closed. (The popover prevents
 * Kobalte's outside-pointerdown dismissal for exactly that element, so
 * the gesture reaches this branch as a plain click on an open card.)
 */
export function openProfileCard(
	request: Omit<ProfileCardRequest, "threadRootId"> &
		Partial<Pick<ProfileCardRequest, "threadRootId">>,
): void {
	const current = profileCardRequest();
	if (current && current.anchor === request.anchor) {
		closeProfileCard();
		return;
	}
	// Normalize explicitly: a caller passing `threadRootId: undefined`
	// (from a `string | undefined` source) must still store null, or the
	// composer's strict-equality target match would never fire.
	setProfileCardRequest({
		...request,
		threadRootId: request.threadRootId ?? null,
	});
}

export function closeProfileCard(): void {
	setProfileCardRequest(null);
}
