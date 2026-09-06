import type { MatrixEvent } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createSignal,
	createUniqueId,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { useClient } from "../../../client/client";
import type { RoomSummary } from "../../../client/summaries";
import { getForwardableRooms } from "../../../client/summaries-selectors";
import { Modal } from "../../../components/Modal";
import { createPicker } from "../../../components/picker/Picker";
import { userFacingErrorMessage } from "../../../lib/errorMessage";
import { cryptoDialogOpen } from "../../../stores/cryptoActions";
import { pushNotice } from "../../../stores/notices";
import { forwardMessage } from "./forwardMessage";
import { messagePreviewText } from "./MessagePreview";
import type { TimelineEvent } from "./timelineTypes";

interface ForwardDialogProps {
	/** The message being forwarded; non-null while the dialog is open.
	    Snapshot semantics: the dialog reads it at select time, so a room
	    switch behind the modal can't change the source mid-forward. */
	target: () => TimelineEvent | null;
	/** Resolve the raw SDK event (post-edit content) for a timeline row. */
	getSourceEvent: (eventId: string) => MatrixEvent | undefined;
	onClose: () => void;
}

const { Picker, handlePickerKey, getActiveDescendant, getExpanded, listboxId } =
	createPicker<RoomSummary>();

const ForwardDialog: Component<ForwardDialogProps> = (props) => {
	const { client, summaries } = useClient();
	const open = () => props.target() !== null;

	let inputRef: HTMLInputElement | undefined;
	let mounted = true;
	onCleanup(() => {
		mounted = false;
	});

	const titleId = createUniqueId();
	const inputId = createUniqueId();
	const errorId = createUniqueId();

	const [query, setQuery] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);
	const [forwarding, setForwarding] = createSignal(false);

	// Bumped on every open and on every submit. An in-flight forward
	// captures the value and re-checks it - plus mounted and open - after
	// each await, so a close→reopen cycle can't let a stale continuation
	// commit the notice / close against the fresh dialog (the dialog is
	// hosted session-long in TimelineView, so `mounted` alone can't).
	let submitGeneration = 0;

	const rooms = () => getForwardableRooms(summaries);

	function reset(): void {
		submitGeneration++;
		setQuery("");
		setError(null);
		setForwarding(false);
	}

	/** Close paths share one guard: no closing while a forward is in
	    flight (the media re-upload is uncancellable, so the #440 shape is
	    to keep the modal up and let the inline error / success land). */
	const tryClose = (): void => {
		if (forwarding()) return;
		props.onClose();
	};

	createEffect(
		on(open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				reset();
			}
		}),
	);

	const handleForward = async (room: RoomSummary): Promise<void> => {
		if (forwarding()) return;
		const target = props.target();
		if (!target) return;
		const source = props.getSourceEvent(target.eventId);
		if (!source) {
			setError("Couldn't find the original message. Try again.");
			return;
		}
		setError(null);
		setForwarding(true);
		const myGeneration = ++submitGeneration;
		const stillCurrent = (): boolean =>
			mounted && open() && myGeneration === submitGeneration;
		try {
			await forwardMessage(client, source, room.roomId);
			if (!stillCurrent()) return;
			pushNotice(`Forwarded to ${room.name.trim() || "room"}.`);
			props.onClose();
		} catch (err) {
			if (!stillCurrent()) return;
			console.error("Failed to forward message:", err);
			setForwarding(false);
			setError(
				userFacingErrorMessage(
					err,
					"Couldn't forward the message. Please try again.",
				),
			);
			inputRef?.focus();
		}
	};

	return (
		<Show when={props.target()}>
			{(target) => (
				<Modal
					open
					onClose={tryClose}
					dismissible={!forwarding()}
					labelledBy={titleId}
					suspended={cryptoDialogOpen()}
					initialFocus={() => inputRef}
					class="fixed inset-0 z-50 flex items-center justify-center bg-surface-0/60 p-4"
				>
					<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2
							id={titleId}
							class="mb-1 text-lg font-semibold text-text-primary"
						>
							Forward message
						</h2>
						<p class="mb-4 truncate text-sm text-text-muted">
							{messagePreviewText(target())}
						</p>

						<label
							for={inputId}
							class="mb-1 block text-xs font-medium text-text-secondary"
						>
							Forward to
						</label>
						<div class="relative">
							<input
								id={inputId}
								ref={(el) => {
									inputRef = el;
								}}
								type="text"
								value={query()}
								onInput={(e) => {
									setQuery(e.currentTarget.value);
									if (error()) setError(null);
								}}
								onKeyDown={(e) => {
									// Tab is NOT forwarded to the picker: there it means
									// "select the highlighted room", which would fire an
									// unexpected forward while keyboard-navigating. The
									// dialog's own keydown traps Tab for focus cycling.
									// Escape bubbles to the overlay's guarded close instead
									// of the picker's unguarded one.
									if (e.key === "Tab" || e.key === "Escape") return;
									handlePickerKey(e);
								}}
								placeholder="Search rooms"
								autocomplete="off"
								spellcheck={false}
								disabled={forwarding()}
								role="combobox"
								aria-expanded={getExpanded() ? true : undefined}
								aria-controls={getExpanded() ? listboxId : undefined}
								aria-activedescendant={getActiveDescendant()}
								aria-describedby={error() ? errorId : undefined}
								aria-invalid={error() ? true : undefined}
								class="mb-2 w-full rounded bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-disabled focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
							/>
							<Picker
								items={rooms()}
								query={query()}
								visible={true}
								position={{ bottom: "auto", left: "0" }}
								onSelect={(room) => void handleForward(room)}
								onClose={tryClose}
								filterFn={(room, q) =>
									room.name.toLowerCase().includes(q.trim().toLowerCase())
								}
								renderItem={(room) => (
									<span class="flex items-center gap-2 truncate">
										<span class="truncate">{room.name}</span>
										<Show when={room.isDirect}>
											<span class="shrink-0 text-[10px] text-text-faint">
												DM
											</span>
										</Show>
									</span>
								)}
							/>
						</div>

						<Show when={error()}>
							<p
								id={errorId}
								class="mb-2 text-sm text-danger-text"
								role="alert"
							>
								{error()}
							</p>
						</Show>

						<div class="mt-4 flex justify-end">
							<button
								type="button"
								onClick={tryClose}
								disabled={forwarding()}
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
							>
								Cancel
							</button>
						</div>
					</div>
				</Modal>
			)}
		</Show>
	);
};

export { ForwardDialog };
