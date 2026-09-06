import { useNavigate } from "@solidjs/router";
import type { MatrixClient } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createSignal,
	createUniqueId,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { useClient } from "../../client/client";
import { Modal } from "../../components/Modal";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import {
	formatJoinAddress,
	type JoinAddress,
	parseJoinAddress,
} from "../../lib/joinAddressParsing";
import { cryptoDialogOpen } from "../../stores/cryptoActions";
import { pushNotice } from "../../stores/notices";

/**
 * User-facing message for a failed `client.joinRoom`. Maps the common
 * MatrixError errcodes to actionable text; anything else goes through
 * `userFacingErrorMessage` so server-written messages survive but browser
 * jargon (DOMException, fetch TypeError) becomes the fallback.
 */
export function describeJoinError(err: unknown): string {
	const code =
		err && typeof err === "object" && "errcode" in err
			? (err as { errcode?: unknown }).errcode
			: undefined;
	if (code === "M_NOT_FOUND") {
		return "Couldn't find a room at that address. Check the address and try again.";
	}
	if (code === "M_FORBIDDEN") {
		return INVITE_ONLY_MESSAGE;
	}
	if (code === "M_LIMIT_EXCEEDED") {
		return "You're being rate-limited. Wait a moment, then try again.";
	}
	return userFacingErrorMessage(
		err,
		"Couldn't join the room. Please try again.",
	);
}

/** Extract the MatrixError errcode, if the thrown value carries one. */
function errcode(err: unknown): unknown {
	return err && typeof err === "object" && "errcode" in err
		? (err as { errcode?: unknown }).errcode
		: undefined;
}

/**
 * The invite-only message: shown by describeJoinError for a forbidden
 * join, and by handleKnock when the knock itself is forbidden (proving
 * the room isn't knock-rule after all). One constant so the two arms
 * can't drift.
 */
const INVITE_ONLY_MESSAGE =
	"That room isn't open to join. Ask a member to invite you.";

interface JoinRoomDialogProps {
	client: MatrixClient;
	open: () => boolean;
	onClose: () => void;
	/**
	 * Optional prefill for the address input, read each time the dialog
	 * opens. Used by the permalink router to prefill a matrix.to room link
	 * the user clicked but hasn't joined (issue #441).
	 */
	prefill?: () => JoinAddress | null;
	/**
	 * Open with the knock offer already engaged (space discovery's Request
	 * button - the room is known knock-rule, so the doomed join attempt is
	 * skipped and the reason field shows immediately).
	 */
	knockOffered?: () => boolean;
	/**
	 * The prefill target is known to be a space (space discovery reads the
	 * hierarchy's room_type, #443). Snapshotted at open time alongside the
	 * prefill and cleared when the user edits the address - it only
	 * describes the prefilled target. Used to mark optimistic
	 * joined/knocked stubs as spaces so they surface in the spaces
	 * sidebar rather than Home's room lists until /sync.
	 */
	isSpace?: () => boolean;
}

const JoinRoomDialog: Component<JoinRoomDialogProps> = (props) => {
	const navigate = useNavigate();
	const { optimisticallyMarkJoined, optimisticallyMarkKnocked } = useClient();

	let inputRef: HTMLInputElement | undefined;
	let reasonRef: HTMLInputElement | undefined;
	let mounted = true;
	onCleanup(() => {
		mounted = false;
	});
	/**
	 * Bumped on every open and on every submit. An in-flight submit captures
	 * the value and re-checks it after each await so a close→reopen→resubmit
	 * cycle can't let a stale submit commit navigation/side effects.
	 */
	let submitGeneration = 0;

	const titleId = createUniqueId();
	const inputId = createUniqueId();
	const errorId = createUniqueId();
	const reasonId = createUniqueId();
	const offerId = createUniqueId();

	const [inputValue, setInputValue] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);
	const [submitting, setSubmitting] = createSignal(false);
	// Knock offer (#442): set when a join attempt 403s - the room may be
	// knock-rule, so the dialog offers "Request to join" (with an optional
	// reason) instead of only the M_FORBIDDEN error text.
	const [knockOffered, setKnockOffered] = createSignal(false);
	// Snapshot of the request's isSpace flag, taken at the open edge with
	// the prefill and cleared by reset() and by any address edit (the
	// flag only describes the prefilled target).
	const [prefillIsSpace, setPrefillIsSpace] = createSignal(false);
	const [knockReason, setKnockReason] = createSignal("");

	function reset(): void {
		submitGeneration++;
		setInputValue("");
		setError(null);
		setSubmitting(false);
		setKnockOffered(false);
		setKnockReason("");
		setPrefillIsSpace(false);
	}

	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				reset();
				// Prefill after reset() (which clears the input) so a stale
				// prefill from an earlier open can't survive a fresh one.
				const prefill = props.prefill?.();
				if (prefill) setInputValue(formatJoinAddress(prefill));
				setPrefillIsSpace(props.isSpace?.() ?? false);
				if (props.knockOffered?.()) {
					setKnockOffered(true);
				}
			}
		}),
	);

	const tryClose = (): void => {
		if (submitting()) return;
		props.onClose();
	};

	const handleSubmit = async (e: Event): Promise<void> => {
		e.preventDefault();
		if (submitting()) return;

		// With the knock offer engaged, submitting the form (Enter in either
		// input) sends the knock - the Join submit button is unmounted in
		// this state, so without this routing Enter would re-fire the
		// doomed join against the address that just 403'd.
		if (knockOffered()) {
			await handleKnock();
			return;
		}

		const parsed = parseJoinAddress(inputValue());
		if (!parsed.ok) {
			setError(parsed.error);
			// Match the catch path's refocus: a mouse user who clicked Join
			// lands back on the field to fix the address, not on the button.
			inputRef?.focus();
			return;
		}
		const { idOrAlias, viaServers } = parsed.address;

		const myGeneration = ++submitGeneration;
		setError(null);
		setSubmitting(true);
		try {
			const room = await props.client.joinRoom(idOrAlias, { viaServers });
			if (!mounted || !props.open() || myGeneration !== submitGeneration)
				return;
			// joinRoom resolves before /sync delivers the room's state, so stub
			// the summary entry to make the room appear in the Home list (and
			// RoomPane renderable) immediately - the same reconciliation the
			// space-discovery join relies on (#132). The address is the best
			// name available until sync overwrites the stub. A target known
			// to be a space (prefill flag, #443) stubs as a space and lands
			// on the space route instead of Home.
			optimisticallyMarkJoined(room.roomId, {
				name: idOrAlias,
				avatarUrl: null,
				isSpace: prefillIsSpace(),
			});
			navigate(
				prefillIsSpace()
					? `/space/${encodeURIComponent(room.roomId)}`
					: `/home/${encodeURIComponent(room.roomId)}`,
			);
			props.onClose();
		} catch (err) {
			if (!mounted || !props.open() || myGeneration !== submitGeneration)
				return;
			console.error(`Failed to join room ${idOrAlias}:`, err);
			setSubmitting(false);
			if (errcode(err) === "M_FORBIDDEN") {
				// The room may be knock-rule - the 403 carries no join-rule
				// hint, so offer the knock path and let knockRoom itself
				// decide (it 403s on invite-only rooms too). Focus the
				// reason input: the Join button that had focus is about to
				// unmount, and the reason field is the offer's first control.
				setKnockOffered(true);
				queueMicrotask(() => reasonRef?.focus());
				return;
			}
			setError(describeJoinError(err));
			// Disabling the input during submit dropped focus to <body>; restore
			// it so a keyboard/screen-reader user lands back on the field to fix
			// their input rather than being stranded outside the dialog.
			inputRef?.focus();
		}
	};

	const handleKnock = async (): Promise<void> => {
		if (submitting()) return;
		// Editing the address resets the offer (see onInput), so the parsed
		// address here is the one that just 403'd. Guard anyway.
		const parsed = parseJoinAddress(inputValue());
		if (!parsed.ok) {
			setKnockOffered(false);
			setError(parsed.error);
			return;
		}
		const { idOrAlias, viaServers } = parsed.address;
		const reason = knockReason().trim();

		const myGeneration = ++submitGeneration;
		setError(null);
		setSubmitting(true);
		try {
			const { room_id } = await props.client.knockRoom(idOrAlias, {
				...(reason ? { reason } : {}),
				viaServers,
			});
			if (!mounted || !props.open() || myGeneration !== submitGeneration)
				return;
			// Stub the summary entry with membership "knock" so the room
			// appears in the sidebar's Requests section immediately - the
			// same reconciliation joinRoom's stub does for joined rooms.
			optimisticallyMarkKnocked(room_id, {
				name: idOrAlias,
				avatarUrl: null,
				isSpace: prefillIsSpace(),
			});
			pushNotice("Request to join sent.");
			props.onClose();
		} catch (err) {
			if (!mounted || !props.open() || myGeneration !== submitGeneration)
				return;
			console.error(`Failed to knock room ${idOrAlias}:`, err);
			setSubmitting(false);
			if (errcode(err) === "M_FORBIDDEN") {
				// knockRoom 403 means the room isn't knock-rule after all -
				// drop the offer and show the plain invite-only message.
				// The focused Request-to-join button unmounts with the
				// offer, so land focus back on the address input (the
				// thing the user can change), as the join catch does.
				setKnockOffered(false);
				setError(INVITE_ONLY_MESSAGE);
				inputRef?.focus();
			} else {
				setError(
					userFacingErrorMessage(
						err,
						"Couldn't send the join request. Please try again.",
					),
				);
				// The offer stays mounted; the disabled-during-submit reason
				// input re-enabled without focus, so restore it.
				reasonRef?.focus();
			}
		}
	};

	return (
		<Modal
			class="fixed inset-0 z-50 flex items-center justify-center bg-surface-0/60 p-4"
			open={props.open()}
			onClose={tryClose}
			dismissible={!submitting()}
			labelledBy={titleId}
			suspended={cryptoDialogOpen()}
			initialFocus={() => (knockOffered() ? reasonRef : inputRef)}
		>
			<form
				class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl"
				onSubmit={handleSubmit}
			>
				<h2 id={titleId} class="mb-1 text-lg font-semibold text-text-primary">
					Join a room
				</h2>
				<p class="mb-4 text-sm text-text-muted">
					Enter a room address (#alias:server) or a room ID with servers to try
					(!id:server example.org), or paste a matrix.to link.
				</p>

				<label
					for={inputId}
					class="mb-1 block text-xs font-medium text-text-secondary"
				>
					Room address or link
				</label>
				<input
					id={inputId}
					ref={(el) => {
						inputRef = el;
					}}
					type="text"
					value={inputValue()}
					onInput={(e) => {
						setInputValue(e.currentTarget.value);
						if (error()) setError(null);
						// Editing the address invalidates the prefill's isSpace
						// flag - it only described the prefilled target.
						if (prefillIsSpace()) setPrefillIsSpace(false);
						// Editing the address after a 403 invalidates the knock
						// offer - it was for the old address. Clear the typed
						// reason too, so it can't leak into a re-triggered
						// offer for a different room.
						if (knockOffered()) {
							setKnockOffered(false);
							setKnockReason("");
						}
					}}
					placeholder="#general:example.org"
					autocomplete="off"
					spellcheck={false}
					disabled={submitting()}
					aria-describedby={error() ? errorId : undefined}
					aria-invalid={error() ? true : undefined}
					class="mb-2 w-full rounded bg-surface-2 px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-disabled focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
				/>

				<Show when={error()}>
					<p id={errorId} class="mb-2 text-sm text-danger-text" role="alert">
						{error()}
					</p>
				</Show>

				<Show when={knockOffered()}>
					<div class="mb-2 rounded bg-surface-2 p-3">
						<p id={offerId} class="mb-2 text-sm text-text-secondary">
							That room needs an invitation - or send a join request and a
							moderator can let you in.
						</p>
						<label
							for={reasonId}
							class="mb-1 block text-xs font-medium text-text-secondary"
						>
							Reason (optional)
						</label>
						<input
							id={reasonId}
							ref={(el) => {
								reasonRef = el;
							}}
							type="text"
							value={knockReason()}
							onInput={(e) => setKnockReason(e.currentTarget.value)}
							placeholder="Let me in, please"
							autocomplete="off"
							disabled={submitting()}
							aria-describedby={offerId}
							class="w-full rounded bg-surface-3 px-3 py-2 text-sm text-text-primary placeholder:text-text-disabled focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
						/>
					</div>
				</Show>

				<div class="mt-4 flex justify-end gap-2">
					<button
						type="button"
						onClick={tryClose}
						disabled={submitting()}
						class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
					>
						Cancel
					</button>
					<Show
						when={knockOffered()}
						fallback={
							<button
								type="submit"
								disabled={submitting()}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
							>
								{submitting() ? "Joining…" : "Join"}
							</button>
						}
					>
						<button
							type="button"
							onClick={() => void handleKnock()}
							disabled={submitting()}
							class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
						>
							{submitting() ? "Sending…" : "Request to join"}
						</button>
					</Show>
				</div>
			</form>
		</Modal>
	);
};

export { JoinRoomDialog };
