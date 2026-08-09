import { type Component, createMemo } from "solid-js";
import { useClient } from "../../../client/client";
import { InviteCard } from "./InviteCard";
import { getInviteDetails } from "./inviteDetails";
import { useInviteActions } from "./useInviteActions";

/**
 * Accept/decline panel shown in the room-list pane when the selected space is
 * one the user has only been invited to (no authoritative child list exists
 * yet, so there is nothing else to render there). Accepting flips the space's
 * membership to "join", which swaps this panel for the normal joined-rooms +
 * Discover view in place; declining navigates away via `onDeclined`.
 *
 * Callers should key this component by space ID so in-flight/error state
 * never leaks across a switch between two invited spaces.
 */
const SpaceInvitePanel: Component<{
	spaceId: string;
	onDeclined: () => void;
}> = (props) => {
	const { client, summaries } = useClient();
	const actions = useInviteActions(() => props.spaceId, {
		onDeclined: () => props.onDeclined(),
	});

	const details = createMemo(() => {
		const room = client.getRoom(props.spaceId);
		const myUserId = client.getUserId();
		return room && myUserId ? getInviteDetails(room, myUserId) : null;
	});

	return (
		<div class="flex justify-center p-3">
			<InviteCard
				name={summaries[props.spaceId]?.name?.trim() || "Unnamed space"}
				avatarUrl={summaries[props.spaceId]?.avatarUrl ?? null}
				isSpace
				isDirect={false}
				inviterName={details()?.inviterName ?? null}
				inviterId={details()?.inviterId ?? null}
				reason={details()?.reason ?? null}
				pending={actions.pending}
				error={actions.error}
				onAccept={() => void actions.accept()}
				onDecline={() => void actions.decline()}
			/>
		</div>
	);
};

export { SpaceInvitePanel };
