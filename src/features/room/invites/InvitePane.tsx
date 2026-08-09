import { type Component, createMemo, Show } from "solid-js";
import { useClient } from "../../../client/client";
import { isMobile } from "../../../stores/viewport";
import { InviteCard } from "./InviteCard";
import { getInviteDetails } from "./inviteDetails";
import { useInviteActions } from "./useInviteActions";

/**
 * Main-pane view for a room the user has a pending invite to. Rendered by
 * `Layout` in place of `RoomPane` (an invited user can't read the timeline or
 * send messages, so none of the room chrome applies). Accepting flips the
 * summary membership to "join", which swaps this pane for the real RoomPane
 * in place; declining navigates back to the list via `onDeclined`.
 */
const InvitePane: Component<{
	rid: string;
	roomName: string;
	onBack: () => void;
	onDeclined: () => void;
}> = (props) => {
	const { client, summaries } = useClient();
	const actions = useInviteActions(() => props.rid, {
		onDeclined: () => props.onDeclined(),
	});

	// Static per-mount snapshot is fine: Layout keys the pane by room ID, and
	// stripped invite state doesn't meaningfully change while the card is open.
	const details = createMemo(() => {
		const room = client.getRoom(props.rid);
		const myUserId = client.getUserId();
		return room && myUserId ? getInviteDetails(room, myUserId) : null;
	});

	return (
		<div class="flex h-full flex-col">
			<div class="flex min-h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
				<Show when={isMobile()}>
					<button
						type="button"
						onClick={() => props.onBack()}
						class="-ml-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover"
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
				<InviteCard
					name={props.roomName}
					avatarUrl={summaries[props.rid]?.avatarUrl ?? null}
					isSpace={summaries[props.rid]?.isSpace === true}
					isDirect={details()?.isDirect === true}
					inviterName={details()?.inviterName ?? null}
					inviterId={details()?.inviterId ?? null}
					reason={details()?.reason ?? null}
					pending={actions.pending}
					error={actions.error}
					onAccept={() => void actions.accept()}
					onDecline={() => void actions.decline()}
				/>
			</div>
		</div>
	);
};

export { InvitePane };
