import type { MatrixClient } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createSignal,
	createUniqueId,
	on,
	Show,
} from "solid-js";
import { validateMatrixUserId } from "../inviteValidation";

export function describeInviteError(err: unknown): string {
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

interface InviteByUserIdFormProps {
	client: MatrixClient;
	roomId: string;
	/**
	 * When this accessor returns a new value, the form clears its
	 * input and status messages. Useful for resetting the form when
	 * the wrapping dialog reopens.
	 */
	resetSignal?: () => unknown;
	/**
	 * Receives the rendered input element so the parent can manage
	 * focus (initial focus, focus restoration after errors, etc.).
	 */
	onInputRef?: (el: HTMLInputElement) => void;
	/** Reports submission state to the parent (e.g. to disable Close). */
	onSubmittingChange?: (submitting: boolean) => void;
	/**
	 * Optional scope element. When provided, the form will re-focus the
	 * input after a submit attempt only if `document.activeElement` is
	 * still within this element — avoiding focus theft if the user has
	 * moved on. When omitted, focus is restored unconditionally.
	 */
	focusScope?: () => HTMLElement | null | undefined;
	submitLabel?: string;
}

const InviteByUserIdForm: Component<InviteByUserIdFormProps> = (props) => {
	let inputRef: HTMLInputElement | undefined;

	const [inputValue, setInputValue] = createSignal("");
	const [errorText, setErrorText] = createSignal("");
	const [successText, setSuccessText] = createSignal("");
	const [submitting, setSubmitting] = createSignal(false);

	const titleId = createUniqueId();
	const errorId = `${titleId}-error`;
	const statusId = `${titleId}-status`;
	const inputId = `${titleId}-input`;

	createEffect(
		on(
			() => props.resetSignal?.(),
			() => {
				if (!props.resetSignal) return;
				setInputValue("");
				setErrorText("");
				setSuccessText("");
				setSubmitting(false);
			},
			{ defer: true },
		),
	);

	createEffect(() => {
		props.onSubmittingChange?.(submitting());
	});

	const shouldRefocus = (): boolean => {
		const scope = props.focusScope?.();
		if (!scope) return true;
		const active = document.activeElement;
		return !!active && scope.contains(active);
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

		const inviteTarget = userId;
		setInputValue("");
		setErrorText("");
		setSuccessText("");
		setSubmitting(true);
		try {
			await props.client.invite(props.roomId, inviteTarget);
			setSuccessText(`Invited ${inviteTarget}.`);
			if (shouldRefocus()) inputRef?.focus();
		} catch (err) {
			setErrorText(describeInviteError(err));
			setInputValue(inviteTarget);
			if (shouldRefocus()) inputRef?.focus();
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<form onSubmit={handleSubmit}>
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
					props.onInputRef?.(el);
				}}
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
				<p id={statusId} class="mb-2 text-sm text-text-secondary" role="status">
					{successText()}
				</p>
			</Show>

			<div class="mt-2 flex justify-end">
				<button
					type="submit"
					disabled={submitting()}
					class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
				>
					{submitting() ? "Inviting…" : (props.submitLabel ?? "Invite")}
				</button>
			</div>
		</form>
	);
};

export { InviteByUserIdForm };
