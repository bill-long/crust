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
import { validateMatrixUserId } from "./inviteValidation";

const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface InviteDialogProps {
	client: MatrixClient;
	/**
	 * Room to invite into. Snapshot taken at open time by the caller;
	 * passing a stable string ensures an in-flight invite always targets
	 * the room the user originally opened the dialog for.
	 */
	roomId: string;
	open: () => boolean;
	onClose: () => void;
}

function describeInviteError(err: unknown): string {
	const code =
		err && typeof err === "object" && "errcode" in err
			? (err as { errcode?: unknown }).errcode
			: undefined;
	if (code === "M_FORBIDDEN") {
		return "You don't have permission to invite to this room.";
	}
	if (code === "M_LIMIT_EXCEEDED") {
		return "You're being rate-limited. Wait a moment, then try again.";
	}
	if (code === "M_NOT_FOUND") {
		return "This room no longer exists or you can't access it.";
	}
	if (err instanceof Error && err.message) return err.message;
	return "Couldn't send the invite. Please try again.";
}

const InviteDialog: Component<InviteDialogProps> = (props) => {
	let overlayRef!: HTMLDivElement;
	let inputRef: HTMLInputElement | undefined;
	let previousFocus: HTMLElement | null = null;

	const [inputValue, setInputValue] = createSignal("");
	const [errorText, setErrorText] = createSignal("");
	const [successText, setSuccessText] = createSignal("");
	const [submitting, setSubmitting] = createSignal(false);

	const titleId = createUniqueId();
	const errorId = createUniqueId();
	const statusId = createUniqueId();

	// React to open/close: capture focus on open; restore + reset on close.
	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				previousFocus = document.activeElement as HTMLElement | null;
				setInputValue("");
				setErrorText("");
				setSuccessText("");
				setSubmitting(false);
				// Focus input after the panel mounts.
				queueMicrotask(() => inputRef?.focus());
			} else if (!isOpen && wasOpen) {
				if (previousFocus && document.body.contains(previousFocus)) {
					previousFocus.focus();
				}
				previousFocus = null;
			}
		}),
	);

	onCleanup(() => {
		if (previousFocus && document.body.contains(previousFocus)) {
			previousFocus.focus();
		}
		previousFocus = null;
	});

	const tryClose = (): void => {
		if (submitting()) return;
		props.onClose();
	};

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape") {
			e.stopPropagation();
			tryClose();
			return;
		}
		if (e.key === "Tab") {
			const focusable = Array.from(
				overlayRef.querySelectorAll<HTMLElement>(FOCUSABLE),
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	};

	const handleSubmit = async (e: Event): Promise<void> => {
		e.preventDefault();
		if (submitting()) return;

		const validation = validateMatrixUserId(inputValue());
		if (!validation.ok) {
			setErrorText(validation.error);
			setSuccessText("");
			return;
		}
		const userId = validation.userId;

		// Client-side pre-checks for nicer UX (server is the source of truth).
		if (userId === props.client.getUserId()) {
			setErrorText("You can't invite yourself.");
			setSuccessText("");
			return;
		}
		const room = props.client.getRoom(props.roomId);
		const existing = room?.getMember(userId);
		if (existing?.membership === "join") {
			setErrorText(`${userId} is already in this room.`);
			setSuccessText("");
			return;
		}
		if (existing?.membership === "invite") {
			setErrorText(`${userId} has already been invited.`);
			setSuccessText("");
			return;
		}

		// Snapshot for the success message; clear the input immediately.
		const inviteTarget = userId;
		setInputValue("");
		setErrorText("");
		setSuccessText("");
		setSubmitting(true);
		try {
			await props.client.invite(props.roomId, inviteTarget);
			setSuccessText(`Invited ${inviteTarget}.`);
			// Re-focus input for another invite, but only if focus is still
			// inside the dialog — don't yank focus if the user has moved on.
			if (
				document.activeElement &&
				overlayRef.contains(document.activeElement)
			) {
				inputRef?.focus();
			}
		} catch (err) {
			setErrorText(describeInviteError(err));
			// Restore the typed value so the user can correct typos.
			setInputValue(inviteTarget);
			if (
				document.activeElement &&
				overlayRef.contains(document.activeElement)
			) {
				inputRef?.focus();
			}
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Show when={props.open()}>
			<div
				ref={overlayRef}
				class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				tabIndex={-1}
				onKeyDown={handleKeyDown}
				onClick={(e) => {
					if (e.target === e.currentTarget) tryClose();
				}}
			>
				<form
					class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl"
					onSubmit={handleSubmit}
				>
					<h2 id={titleId} class="mb-3 text-lg font-semibold text-text-primary">
						Invite to room
					</h2>
					<p class="mb-4 text-sm text-text-muted">
						Enter a Matrix user ID to invite.
					</p>

					<label
						for={`${titleId}-input`}
						class="mb-1 block text-xs font-medium text-text-secondary"
					>
						User ID
					</label>
					<input
						id={`${titleId}-input`}
						ref={inputRef}
						type="text"
						value={inputValue()}
						onInput={(e) => {
							setInputValue(e.currentTarget.value);
							if (errorText()) setErrorText("");
							if (successText()) setSuccessText("");
						}}
						placeholder="@alice:server"
						autocomplete="off"
						spellcheck={false}
						disabled={submitting()}
						aria-describedby={
							errorText() ? errorId : successText() ? statusId : undefined
						}
						aria-invalid={errorText() ? true : undefined}
						class="mb-2 w-full rounded bg-surface-2 px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-disabled focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
					/>

					<Show when={errorText()}>
						<p id={errorId} class="mb-2 text-sm text-danger-text" role="alert">
							{errorText()}
						</p>
					</Show>
					<Show when={successText()}>
						<p
							id={statusId}
							class="mb-2 text-sm text-text-secondary"
							role="status"
						>
							{successText()}
						</p>
					</Show>

					<div class="mt-4 flex justify-end gap-2">
						<button
							type="button"
							onClick={tryClose}
							disabled={submitting()}
							class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
						>
							Close
						</button>
						<button
							type="submit"
							disabled={submitting()}
							class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
						>
							{submitting() ? "Inviting…" : "Invite"}
						</button>
					</div>
				</form>
			</div>
		</Show>
	);
};

export { InviteDialog };
