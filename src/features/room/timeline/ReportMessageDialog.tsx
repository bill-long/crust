import { type Component, createEffect, createSignal, on, Show } from "solid-js";
import { useClient } from "../../../client/client";
import { userFacingErrorMessage } from "../../../lib/errorMessage";
import { pushNotice } from "../../../stores/notices";
import { ConfirmDialog } from "../settings/ConfirmDialog";
import type { TimelineEvent } from "./timelineTypes";

interface ReportMessageDialogProps {
	/** The message being reported; non-null while the dialog is open. */
	target: () => TimelineEvent | null;
	roomId: () => string;
	onClose: () => void;
}

/**
 * Report a message to the homeserver admins (`POST
 * /rooms/{roomId}/report/{eventId}`, #447). The score is fixed at -100
 * ("most offensive") like Element's report flow - a numeric offensiveness
 * slider is UI nobody can meaningfully use. Submission failure renders
 * inline in the dialog (ConfirmDialog's error surface).
 */
const ReportMessageDialog: Component<ReportMessageDialogProps> = (props) => {
	const { client } = useClient();
	const [reason, setReason] = createSignal("");
	const open = () => props.target() !== null;

	// A fresh open must not inherit the previous report's reason. The
	// roomId is snapshotted at open so a room switch behind the modal
	// can't retarget an in-flight report.
	let reportRoomId = "";
	createEffect(
		on(open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				setReason("");
				reportRoomId = props.roomId();
			}
		}),
	);

	return (
		<ConfirmDialog
			open={open}
			onClose={props.onClose}
			title="Report message"
			destructive
			confirmLabel="Report"
			pendingLabel="Reporting…"
			onConfirm={async () => {
				const target = props.target();
				if (!target) return;
				try {
					await client.reportEvent(
						reportRoomId,
						target.eventId,
						-100,
						reason().trim(),
					);
				} catch (err) {
					console.error("Report message failed:", err);
					// Rethrow with a user-facing text; ConfirmDialog renders
					// the message inline (per the dialog error convention).
					throw new Error(
						userFacingErrorMessage(err, "Couldn't send the report. Try again."),
					);
				}
				pushNotice("Report sent to the server admins.");
				props.onClose();
			}}
			body={
				<div class="flex flex-col gap-3">
					<p>
						Report this message to your homeserver's administrators? The message
						sender is not notified.
					</p>
					<Show when={props.target()}>
						{(target) => (
							<p class="truncate rounded bg-surface-2 px-3 py-2 text-text-muted">
								{target().body.trim() || "Attachment"}
							</p>
						)}
					</Show>
					<label class="flex flex-col gap-1">
						<span class="text-xs font-medium text-text-secondary">
							Reason (optional)
						</span>
						<textarea
							value={reason()}
							onInput={(e) => setReason(e.currentTarget.value)}
							placeholder="What's wrong with this message?"
							rows={3}
							class="w-full resize-none rounded bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-disabled focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
						/>
					</label>
				</div>
			}
		/>
	);
};

export { ReportMessageDialog };
