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

export function openProfileCard(
	request: Omit<ProfileCardRequest, "threadRootId"> &
		Partial<Pick<ProfileCardRequest, "threadRootId">>,
): void {
	setProfileCardRequest({ threadRootId: null, ...request });
}

export function closeProfileCard(): void {
	setProfileCardRequest(null);
}
