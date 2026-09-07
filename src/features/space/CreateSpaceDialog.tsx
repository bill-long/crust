import { useNavigate } from "@solidjs/router";
import {
	EventType,
	type MatrixClient,
	RoomType,
	Visibility,
} from "matrix-js-sdk";
import { useClient } from "../../client/client";
import {
	CreateEntityForm,
	type CreateEntitySubmission,
} from "../room/CreateEntityForm";

interface CreateSpaceDialogProps {
	client: MatrixClient;
	open: () => boolean;
	onClose: () => void;
}

export function CreateSpaceDialog(props: CreateSpaceDialogProps) {
	const navigate = useNavigate();
	const { optimisticallyMarkJoined } = useClient();
	async function handleSubmit(submission: CreateEntitySubmission) {
		const { options, avatarUrl, isCurrent } = submission;
		options.creation_content = { type: RoomType.Space };
		// Only admins post/set state; moderators can invite and add child rooms.
		options.power_level_content_override = {
			events_default: 100,
			state_default: 100,
			users_default: 0,
			invite: 50,
			events: { [EventType.SpaceChild]: 50 },
		};
		options.initial_state = [
			{
				type: EventType.RoomHistoryVisibility,
				state_key: "",
				content: {
					history_visibility:
						options.visibility === Visibility.Public
							? "world_readable"
							: "shared",
				},
			},
			{
				type: EventType.RoomGuestAccess,
				state_key: "",
				content: { guest_access: "forbidden" },
			},
			...(options.initial_state ?? []),
		];
		const { room_id } = await props.client.createRoom(options);
		if (!isCurrent()) return;
		optimisticallyMarkJoined(room_id, {
			name: options.name,
			avatarUrl,
			isSpace: true,
		});
		navigate(`/space/${encodeURIComponent(room_id)}`);
		props.onClose();
	}
	return (
		<CreateEntityForm
			client={props.client}
			open={props.open}
			onClose={props.onClose}
			onSubmit={handleSubmit}
			title="Create space"
			description="Spaces group rooms and people. You can add rooms later."
			namePlaceholder="My space"
			aliasPlaceholder="my-space"
			topicPlaceholder="What's this space about?"
			failureMessage="Failed to create the space."
		/>
	);
}
