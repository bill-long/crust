import type { MatrixClient } from "matrix-js-sdk";
import { type Component, createEffect, createSignal } from "solid-js";
import {
	clearJoinDialogRequest,
	joinDialogRequest,
} from "../../stores/joinDialog";
import { JoinRoomDialog } from "./JoinRoomDialog";

/**
 * Session-long host for the join-room dialog, mounted once by `Layout`.
 *
 * The dialog can't live in `RoomList` (its pre-#441 home): MobileLayout
 * unmounts the room list while a room is open, so a join request issued
 * from a permalink tap there would sit in the joinDialog store unanswered
 * - a dead click in the moment, and a surprise dialog popping open when
 * the user later backed out to the room list. `Layout` is always mounted,
 * so hosting here makes the store-driven open path reliable on every
 * viewport.
 */
const JoinRoomDialogHost: Component<{ client: MatrixClient }> = (props) => {
	const [open, setOpen] = createSignal(false);

	createEffect(() => {
		if (joinDialogRequest()) setOpen(true);
	});

	const close = (): void => {
		// Drop the request that brought the dialog up (or is still pending)
		// so the next open starts from a clean slate.
		clearJoinDialogRequest();
		setOpen(false);
	};

	return (
		<JoinRoomDialog
			client={props.client}
			open={open}
			onClose={close}
			prefill={() => joinDialogRequest()?.prefill ?? null}
			knockOffered={() => joinDialogRequest()?.knockOffered ?? false}
			isSpace={() => joinDialogRequest()?.isSpace ?? false}
		/>
	);
};

export { JoinRoomDialogHost };
