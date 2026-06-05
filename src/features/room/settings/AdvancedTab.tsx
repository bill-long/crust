import type { MatrixClient } from "matrix-js-sdk";
import { type Component, createSignal, Show } from "solid-js";
import { ConfirmDialog } from "./ConfirmDialog";
import { HistoryVisibilitySection } from "./HistoryVisibilitySection";
import { JoinRuleSection } from "./JoinRuleSection";

interface AdvancedTabProps {
	client: MatrixClient;
	roomId: string;
	onLeft?: (roomId: string) => void;
	/** When true, label copy uses "space" instead of "room". */
	isSpace?: boolean;
}

const AdvancedTab: Component<AdvancedTabProps> = (props) => {
	// ----- Leave -----
	const [showLeave, setShowLeave] = createSignal(false);

	const handleLeave = async (): Promise<void> => {
		await props.client.leave(props.roomId);
		props.onLeft?.(props.roomId);
	};

	const roomName = (): string => {
		const r = props.client.getRoom(props.roomId);
		const n = r?.name?.trim();
		return n || props.roomId;
	};

	return (
		<div class="space-y-8">
			{/* Join rule + history visibility live in Advanced for regular rooms.
			    For spaces they move to the dedicated Visibility tab, so they are
			    hidden here to avoid two UIs editing the same state. */}
			<Show when={!props.isSpace}>
				<JoinRuleSection client={props.client} roomId={props.roomId} />
				<HistoryVisibilitySection client={props.client} roomId={props.roomId} />
			</Show>

			{/* Leave */}
			<section>
				<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
					Danger zone
				</h3>
				<button
					type="button"
					onClick={() => setShowLeave(true)}
					class="rounded bg-danger-bg px-4 py-2 text-sm font-semibold text-danger-text transition-colors hover:bg-danger-bg/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-text"
				>
					{props.isSpace ? "Leave space" : "Leave room"}
				</button>
			</section>

			<ConfirmDialog
				open={showLeave}
				onClose={() => setShowLeave(false)}
				title={`Leave ${roomName()}?`}
				body={
					<p>
						{props.isSpace
							? "You'll be removed from this space. You can rejoin if the space is public or someone re-invites you. Rooms you're a member of inside the space will not be affected."
							: "You'll stop receiving messages in this room. You can rejoin if the room is public or someone re-invites you."}
					</p>
				}
				confirmLabel="Leave"
				pendingLabel="Leaving…"
				destructive
				onConfirm={async () => {
					await handleLeave();
					setShowLeave(false);
				}}
			/>
		</div>
	);
};

export { AdvancedTab };
