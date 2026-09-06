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
import { validateMatrixUserId } from "../../lib/inviteValidation";
import { cryptoDialogOpen } from "../../stores/cryptoActions";
import { startDm } from "./startDm";

interface NewDmDialogProps {
	client: MatrixClient;
	open: () => boolean;
	onClose: () => void;
}

const NewDmDialog: Component<NewDmDialogProps> = (props) => {
	const navigate = useNavigate();
	const { optimisticallyMarkJoined } = useClient();

	let inputRef: HTMLInputElement | undefined;
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

	const [inputValue, setInputValue] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);
	const [submitting, setSubmitting] = createSignal(false);

	function reset(): void {
		submitGeneration++;
		setInputValue("");
		setError(null);
		setSubmitting(false);
	}

	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				reset();
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

		const validation = validateMatrixUserId(inputValue());
		if (!validation.ok) {
			setError(validation.error);
			return;
		}
		const userId = validation.userId;
		if (userId === props.client.getUserId()) {
			setError("You can't start a conversation with yourself.");
			return;
		}

		const myGeneration = ++submitGeneration;
		setError(null);
		setSubmitting(true);
		try {
			const { roomId } = await startDm(props.client, userId);
			if (!mounted || !props.open() || myGeneration !== submitGeneration)
				return;
			optimisticallyMarkJoined(roomId, {
				name: userId,
				avatarUrl: null,
				isDirect: true,
			});
			navigate(`/dm/${encodeURIComponent(roomId)}`);
			props.onClose();
		} catch (err) {
			if (!mounted || !props.open() || myGeneration !== submitGeneration)
				return;
			setError(
				err instanceof Error
					? err.message
					: "Couldn't start the conversation. Please try again.",
			);
			setSubmitting(false);
			// Disabling the input during submit dropped focus to <body>; restore
			// it so a keyboard/screen-reader user lands back on the field to fix
			// their input rather than being stranded outside the dialog.
			inputRef?.focus();
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
			initialFocus={() => inputRef}
		>
			<form
				class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl"
				onSubmit={handleSubmit}
			>
				<h2 id={titleId} class="mb-1 text-lg font-semibold text-text-primary">
					New direct message
				</h2>
				<p class="mb-4 text-sm text-text-muted">
					Enter a Matrix user ID to start a private conversation.
				</p>

				<label
					for={inputId}
					class="mb-1 block text-xs font-medium text-text-secondary"
				>
					User ID
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
					}}
					placeholder="@alice:server"
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

				<div class="mt-4 flex justify-end gap-2">
					<button
						type="button"
						onClick={tryClose}
						disabled={submitting()}
						class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={submitting()}
						class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
					>
						{submitting() ? "Starting…" : "Start chat"}
					</button>
				</div>
			</form>
		</Modal>
	);
};

export { NewDmDialog };
