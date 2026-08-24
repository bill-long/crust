import { type Component, createSignal, Show } from "solid-js";
import { useClient } from "../../../client/client";
import { userFacingErrorMessage } from "../../../lib/errorMessage";
import { isMobile } from "../../../stores/viewport";

/**
 * Main-pane view for a room the user has a pending join request (knock) in.
 * Rendered by `Layout` in place of `RoomPane` (a knocking user can't read
 * the timeline or send messages, exactly like an invited user - #438's
 * InvitePane is the sibling). Shows the pending state and offers
 * cancellation. A moderator approving the knock re-memberships the user as
 * invited (MSC2403), which swaps this pane for InvitePane to accept; servers
 * that auto-join approved knocks flip straight to "join" and RoomPane.
 */
const KnockPane: Component<{
	rid: string;
	roomName: string;
	onBack: () => void;
	/** Called after the cancellation succeeds (Layout navigates to the list). */
	onCancelled: () => void;
}> = (props) => {
	const { client, optimisticallyMarkLeft } = useClient();
	const [cancelling, setCancelling] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	const cancelRequest = async (): Promise<void> => {
		if (cancelling()) return;
		const rid = props.rid;
		setCancelling(true);
		setError(null);
		try {
			await client.leave(rid);
			// Navigate away BEFORE flipping the store: Layout picks this pane
			// over RoomPane via `membership === "knock"`, so marking the room
			// "leave" while the route still points at it would transiently
			// mount RoomPane for a room the user just left (the same ordering
			// useInviteActions.decline documents for invites).
			props.onCancelled();
			optimisticallyMarkLeft(rid);
		} catch (err) {
			console.error(`Failed to cancel join request for ${rid}:`, err);
			setError(
				userFacingErrorMessage(
					err,
					"Couldn't cancel the join request. Please try again.",
				),
			);
			setCancelling(false);
		}
	};

	return (
		<div class="flex h-full flex-col">
			<div class="flex min-h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
				<Show when={isMobile()}>
					<button
						type="button"
						onClick={() => props.onBack()}
						class="-ml-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover"
						title="Back to room list"
						aria-label="Back to room list"
					>
						<svg
							class="h-5 w-5"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
						>
							<polyline points="15 18 9 12 15 6" />
						</svg>
					</button>
				</Show>
				<span class="min-w-0 truncate text-sm font-semibold text-text-emphasis">
					{props.roomName}
				</span>
			</div>
			<div class="flex flex-1 items-center justify-center p-4">
				<div class="w-full max-w-sm rounded-lg border border-border-subtle bg-surface-1 p-6 text-center">
					<span class="mx-auto mb-3 flex h-6 w-fit items-center rounded-full bg-surface-3 px-2.5 text-[10px] font-bold text-text-muted">
						Requested
					</span>
					<p class="mb-1 text-sm font-semibold text-text-primary">
						{props.roomName}
					</p>
					<p class="mb-4 text-sm text-text-muted">
						Your request to join is waiting for a moderator to approve it.
					</p>
					<Show when={error()}>
						<p class="mb-3 text-sm text-danger-text" role="alert">
							{error()}
						</p>
					</Show>
					<button
						type="button"
						onClick={() => void cancelRequest()}
						disabled={cancelling()}
						class="rounded px-3 py-2 text-sm text-danger-text transition-colors hover:bg-danger-bg/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-danger-text disabled:cursor-not-allowed disabled:opacity-60"
					>
						{cancelling() ? "Cancelling…" : "Cancel request"}
					</button>
				</div>
			</div>
		</div>
	);
};

export { KnockPane };
