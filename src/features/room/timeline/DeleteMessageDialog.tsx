import { type Component, createEffect, createSignal, on, Show } from "solid-js";
import { ConfirmDialog } from "../settings/ConfirmDialog";
import { MessagePreview } from "./MessagePreview";
import type { TimelineEvent } from "./timelineTypes";

interface DeleteMessageDialogProps {
	/** The message being deleted; non-null while the dialog is open. */
	target: () => TimelineEvent | null;
	onClose: () => void;
	/**
	 * Fire the (optimistic) redaction. The dialog closes immediately -
	 * failure surfaces inline on the row's "Delete failed" affordance, not
	 * here.
	 */
	onDelete: (eventId: string, reason: string) => void;
}

/**
 * Delete confirmation with an optional redaction reason (#447). The reason
 * goes out on the wire (`m.room.redaction` content), where other clients
 * and moderation tooling surface it; Crust itself removes confirmed
 * redacted rows outright, so it renders nowhere locally.
 */
const DeleteMessageDialog: Component<DeleteMessageDialogProps> = (props) => {
	const [reason, setReason] = createSignal("");
	const open = () => props.target() !== null;

	// A fresh open must not inherit the previous delete's reason.
	createEffect(
		on(open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) setReason("");
		}),
	);

	return (
		<ConfirmDialog
			open={open}
			onClose={props.onClose}
			title="Delete message"
			destructive
			confirmLabel="Delete"
			onConfirm={() => {
				const target = props.target();
				if (!target) return;
				props.onDelete(target.eventId, reason());
				props.onClose();
			}}
			body={
				<div class="flex flex-col gap-3">
					<p>
						Are you sure you want to delete this message? This cannot be undone.
					</p>
					<Show when={props.target()}>
						{(target) => <MessagePreview body={target().body} />}
					</Show>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium text-text-secondary">
							Reason (optional)
						</span>
						<input
							type="text"
							value={reason()}
							onInput={(e) => setReason(e.currentTarget.value)}
							placeholder="Visible to other clients and moderators"
							autocomplete="off"
							spellcheck={false}
							class="w-full rounded bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-disabled focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
						/>
					</label>
				</div>
			}
		/>
	);
};

export { DeleteMessageDialog };
