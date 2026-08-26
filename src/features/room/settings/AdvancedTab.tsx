import type { MatrixClient } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	on,
	Show,
} from "solid-js";
import { useClient } from "../../../client/client";
import { endCallForRoomLeave } from "../call/rtc/endCall";
import { ConfirmDialog } from "./ConfirmDialog";
import { HistoryVisibilitySection } from "./HistoryVisibilitySection";
import { JoinRuleSection } from "./JoinRuleSection";

interface AdvancedTabProps {
	client: MatrixClient;
	roomId: string;
	onLeft?: (roomId: string) => void;
	/** Called when the Forget action completes (room purged server-side). */
	onForgot?: (roomId: string) => void;
	/** When true, label copy uses "space" instead of "room". */
	isSpace?: boolean;
}

const AdvancedTab: Component<AdvancedTabProps> = (props) => {
	// ----- Leave / Forget -----
	// One confirm dialog covers both danger actions (KickBanConfirm-style).
	// The action is SNAPSHOTTED when the dialog opens: a membership flip
	// mid-flight must not swap the copy under an in-flight request, or a
	// leave failure would render inside a Forget-titled dialog.
	const [showConfirm, setShowConfirm] = createSignal(false);
	const [confirmAction, setConfirmAction] = createSignal<"leave" | "forget">(
		"leave",
	);
	const confirmIsForget = (): boolean => confirmAction() === "forget";
	// True while a confirmed leave/forget request is in flight, so the
	// membership-flip effect below doesn't unmount the dialog out from
	// under a request whose failure still needs to render inline.
	const [actionPending, setActionPending] = createSignal(false);

	// Read membership from the summaries store at the leaf (like the
	// sibling RoomsTab) so every mount is reactive to leave/rejoin from
	// anywhere; the SDK room is only a mount-time fallback for a room the
	// store never saw, so an already-left room still resolves to Forget
	// instead of failing open to a doomed Leave.
	const { summaries } = useClient();
	const membership = (): string | undefined =>
		summaries[props.roomId]?.membership ??
		props.client.getRoom(props.roomId)?.getMyMembership();

	// Forget is only valid (and only useful) once the user is out of the
	// room: the server rejects /forget while joined (spec 10.2.3). Memoized
	// so the dialog-closing effect below fires only on real flips.
	const canForget = createMemo(
		(): boolean => membership() === "leave" || membership() === "ban",
	);

	// If membership flips while the confirm dialog is open but idle
	// (leave/rejoin completed from another device), the offered action is
	// now the wrong one and the server would reject it - close the dialog
	// instead of letting the user confirm a stale action. A dialog with a
	// request in flight is left mounted so a failure can still render its
	// inline error, under the snapshotted action's own copy.
	createEffect(
		on(
			canForget,
			() => {
				if (!actionPending()) setShowConfirm(false);
			},
			{ defer: true },
		),
	);

	const handleLeave = async (): Promise<void> => {
		// Same teardown-before-leave rule the sidebar leave paths use: end a
		// call hosted in this room, awaited, so its MatrixRTC withdrawal is
		// still accepted (see endCallForRoomLeave).
		await endCallForRoomLeave(props.roomId);
		await props.client.leave(props.roomId);
		props.onLeft?.(props.roomId);
	};

	const handleForget = async (): Promise<void> => {
		// deleteRoom=false: local state is dropped by the onForgot chain
		// (Layout's forgetRoomLocally) only AFTER navigating away, so the
		// still-routed room view never renders in a deleted state.
		await props.client.forget(props.roomId, false);
		props.onForgot?.(props.roomId);
	};

	const roomName = (): string => {
		const r = props.client.getRoom(props.roomId);
		const n = r?.name?.trim();
		return n || props.roomId;
	};

	const noun = (): "space" | "room" => (props.isSpace ? "space" : "room");

	return (
		<div class="space-y-8">
			{/* Join rule + history visibility live in Advanced for regular rooms.
			    For spaces they move to the dedicated Visibility tab, so they are
			    hidden here to avoid two UIs editing the same state. Hidden too
			    for a left/banned room: the power-level gate alone would still
			    offer the controls to an ex-admin whose writes the server now
			    rejects. */}
			<Show when={!props.isSpace && !canForget()}>
				<JoinRuleSection client={props.client} roomId={props.roomId} />
				<HistoryVisibilitySection client={props.client} roomId={props.roomId} />
			</Show>

			{/* Leave / Forget */}
			<section>
				<h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
					Danger zone
				</h3>
				<button
					type="button"
					onClick={() => {
						setConfirmAction(canForget() ? "forget" : "leave");
						setShowConfirm(true);
					}}
					class="rounded bg-danger-bg px-4 py-2 text-sm font-semibold text-danger-text transition-colors hover:bg-danger-bg/80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-danger-text"
				>
					{`${canForget() ? "Forget" : "Leave"} ${noun()}`}
				</button>
			</section>

			<ConfirmDialog
				open={showConfirm}
				onClose={() => setShowConfirm(false)}
				title={`${confirmIsForget() ? "Forget" : "Leave"} ${roomName()}?`}
				body={
					<p>
						{confirmIsForget()
							? `This removes the ${noun()} from your account, including your copy of its history.`
							: props.isSpace
								? "You'll be removed from this space. You can rejoin if the space is public or someone re-invites you. Rooms you're a member of inside the space will not be affected."
								: "You'll stop receiving messages in this room. You can rejoin if the room is public or someone re-invites you."}
					</p>
				}
				confirmLabel={confirmIsForget() ? "Forget" : "Leave"}
				pendingLabel={confirmIsForget() ? "Forgetting…" : "Leaving…"}
				destructive
				onConfirm={async () => {
					setActionPending(true);
					try {
						if (confirmIsForget()) {
							await handleForget();
						} else {
							await handleLeave();
						}
					} finally {
						setActionPending(false);
					}
					setShowConfirm(false);
				}}
			/>
		</div>
	);
};

export { AdvancedTab };
