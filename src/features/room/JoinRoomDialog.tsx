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
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { trapTabKey } from "../../lib/focusTrap";
import { parseJoinAddress } from "../../lib/joinAddressParsing";
import { cryptoDialogOpen } from "../../stores/cryptoActions";
import { trackAppModalOpen } from "../../stores/modalStack";

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
		return "That room isn't open to join. Ask a member to invite you.";
	}
	if (code === "M_LIMIT_EXCEEDED") {
		return "You're being rate-limited. Wait a moment, then try again.";
	}
	return userFacingErrorMessage(
		err,
		"Couldn't join the room. Please try again.",
	);
}

interface JoinRoomDialogProps {
	client: MatrixClient;
	open: () => boolean;
	onClose: () => void;
}

const JoinRoomDialog: Component<JoinRoomDialogProps> = (props) => {
	trackAppModalOpen(props.open);
	const navigate = useNavigate();
	const { optimisticallyMarkJoined } = useClient();

	let overlayRef!: HTMLDivElement;
	let inputRef: HTMLInputElement | undefined;
	let previousFocus: HTMLElement | null = null;
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
				previousFocus = document.activeElement as HTMLElement | null;
				reset();
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
			trapTabKey(overlayRef, e);
		}
	};

	const handleSubmit = async (e: Event): Promise<void> => {
		e.preventDefault();
		if (submitting()) return;

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
			// name available until sync overwrites the stub.
			optimisticallyMarkJoined(room.roomId, {
				name: idOrAlias,
				avatarUrl: null,
			});
			navigate(`/home/${encodeURIComponent(room.roomId)}`);
			props.onClose();
		} catch (err) {
			if (!mounted || !props.open() || myGeneration !== submitGeneration)
				return;
			console.error(`Failed to join room ${idOrAlias}:`, err);
			setError(describeJoinError(err));
			setSubmitting(false);
			// Disabling the input during submit dropped focus to <body>; restore
			// it so a keyboard/screen-reader user lands back on the field to fix
			// their input rather than being stranded outside the dialog.
			inputRef?.focus();
		}
	};

	return (
		<Show when={props.open()}>
			<div
				ref={overlayRef}
				class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				inert={cryptoDialogOpen() || undefined}
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
					<h2 id={titleId} class="mb-1 text-lg font-semibold text-text-primary">
						Join a room
					</h2>
					<p class="mb-4 text-sm text-text-muted">
						Enter a room address (#alias:server) or a room ID with servers to
						try (!id:server example.org), or paste a matrix.to link.
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
						}}
						placeholder="#general:example.org"
						autocomplete="off"
						spellcheck={false}
						disabled={submitting()}
						aria-describedby={error() ? errorId : undefined}
						aria-invalid={error() ? true : undefined}
						class="mb-2 w-full rounded bg-surface-2 px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-disabled focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
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
							class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={submitting()}
							class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
						>
							{submitting() ? "Joining…" : "Join"}
						</button>
					</div>
				</form>
			</div>
		</Show>
	);
};

export { JoinRoomDialog };
