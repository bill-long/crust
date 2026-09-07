import { useNavigate } from "@solidjs/router";
import type { MatrixClient } from "matrix-js-sdk";
import { useClient } from "../../client/client";
import { linkRoomToSpace } from "../../lib/spaceChildLink";
import {
	CreateEntityForm,
	type CreateEntitySubmission,
} from "./CreateEntityForm";

interface CreateRoomDialogProps {
	client: MatrixClient;
	open: () => boolean;
	onClose: () => void;
	/** Show the default-checked parent link; captured by the form at open time. */
	spaceId?: string | undefined;
}

export function CreateRoomDialog(props: CreateRoomDialogProps) {
	const navigate = useNavigate();
	const { optimisticallyMarkJoined } = useClient();
	async function handleSubmit(submission: CreateEntitySubmission) {
		const { options, encryption, spaceId, avatarUrl, isCurrent } = submission;
		if (encryption) {
			options.initial_state = [
				{
					type: "m.room.encryption",
					state_key: "",
					content: { algorithm: "m.megolm.v1.aes-sha2" },
				},
				...(options.initial_state ?? []),
			];
		}
		const { room_id } = await props.client.createRoom(options);
		if (!isCurrent()) return;
		optimisticallyMarkJoined(room_id, { name: options.name, avatarUrl });
		// Linking is best-effort: retrying creation would create a second room.
		if (spaceId) await linkRoomToSpace(props.client, spaceId, room_id);
		if (!isCurrent()) return;
		navigate(
			spaceId
				? `/space/${encodeURIComponent(spaceId)}/${encodeURIComponent(room_id)}`
				: `/home/${encodeURIComponent(room_id)}`,
		);
		props.onClose();
	}
	return (
		<CreateEntityForm
			client={props.client}
			open={props.open}
			onClose={props.onClose}
			spaceId={props.spaceId}
			showEncryption
			onSubmit={handleSubmit}
			title="Create room"
			description="A new room on your homeserver."
			namePlaceholder="general"
			aliasPlaceholder="general"
			topicPlaceholder="What's this room about?"
			failureMessage="Failed to create the room."
		/>
	);
}
