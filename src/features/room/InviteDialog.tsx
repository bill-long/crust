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
import { cryptoDialogOpen } from "../../stores/cryptoActions";
import { InviteByUserIdForm } from "./settings/InviteByUserIdForm";

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

const InviteDialog: Component<InviteDialogProps> = (props) => {
	let overlayRef!: HTMLDivElement;
	let inputRef: HTMLInputElement | undefined;
	let previousFocus: HTMLElement | null = null;

	const [submitting, setSubmitting] = createSignal(false);
	const [resetTick, setResetTick] = createSignal(0);

	const titleId = createUniqueId();

	// React to open/close: capture focus on open; restore + reset on close.
	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				previousFocus = document.activeElement as HTMLElement | null;
				setResetTick((n) => n + 1);
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

	return (
		<Show when={props.open()}>
			<div
				ref={overlayRef}
				class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
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
				<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
					<h2 id={titleId} class="mb-3 text-lg font-semibold text-text-primary">
						Invite to room
					</h2>
					<p class="mb-4 text-sm text-text-muted">
						Enter a Matrix user ID to invite.
					</p>

					<InviteByUserIdForm
						client={props.client}
						roomId={props.roomId}
						resetSignal={resetTick}
						onSubmittingChange={setSubmitting}
						onInputRef={(el) => {
							inputRef = el;
						}}
						focusScope={() => overlayRef}
					/>

					<div class="mt-2 flex justify-end">
						<button
							type="button"
							onClick={tryClose}
							disabled={submitting()}
							class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
						>
							Close
						</button>
					</div>
				</div>
			</div>
		</Show>
	);
};

export { InviteDialog };
