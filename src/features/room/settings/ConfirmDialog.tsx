import {
	type Component,
	createEffect,
	createSignal,
	createUniqueId,
	type JSX,
	on,
	Show,
} from "solid-js";
import { Modal } from "../../../components/Modal";
import { cryptoDialogOpen } from "../../../stores/cryptoActions";

/** Input types where Enter means "submit what I typed". */
const ENTER_CONFIRM_INPUT_TYPES = new Set([
	"text",
	"search",
	"email",
	"url",
	"tel",
	"password",
	"number",
]);

interface ConfirmDialogProps {
	open: () => boolean;
	onClose: () => void;
	title: string;
	/** Body — string or any JSX. */
	body: JSX.Element;
	/** Confirm button label. Default: "Confirm". */
	confirmLabel?: string;
	/** Cancel button label. Default: "Cancel". */
	cancelLabel?: string;
	/** If true, confirm button is rendered as a destructive action. */
	destructive?: boolean;
	/**
	 * Confirm handler. May be async. While in-flight, the dialog blocks
	 * close + re-clicks and shows the confirm button as pending.
	 */
	onConfirm: () => void | Promise<void>;
	/** Optional pending label for the confirm button. Default: "Working…". */
	pendingLabel?: string;
}

/**
 * Generic destructive confirm content; Modal owns focus and dismissal.
 *
 * Used for: Leave room (header + Advanced tab), Kick…, Ban…, and the
 * "Anyone can change state" PL preset confirm.
 */
const ConfirmDialog: Component<ConfirmDialogProps> = (props) => {
	let confirmRef: HTMLButtonElement | undefined;

	const [pending, setPending] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	const titleId = createUniqueId();
	const bodyId = createUniqueId();

	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				setPending(false);
				setError(null);
			}
		}),
	);

	const tryClose = (): void => {
		if (pending()) return;
		props.onClose();
	};

	const handleKeyDown = (e: KeyboardEvent): void => {
		// Enter in a text-like single-line field confirms (the
		// type-then-Enter flow, e.g. the delete dialog's reason input).
		// Allowlisted types only: Enter on a checkbox/radio (the leave-space
		// dialog has one) must not confirm a destructive dialog, buttons
		// keep native Enter activation, textareas keep Enter for newlines.
		if (
			e.key === "Enter" &&
			e.target instanceof HTMLInputElement &&
			ENTER_CONFIRM_INPUT_TYPES.has(e.target.type)
		) {
			e.preventDefault();
			void handleConfirm();
			return;
		}
	};

	const handleConfirm = async (): Promise<void> => {
		if (pending()) return;
		setError(null);
		setPending(true);
		try {
			await props.onConfirm();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Action failed.");
		} finally {
			setPending(false);
		}
	};

	return (
		<Modal
			open={props.open()}
			onClose={tryClose}
			dismissible={!pending()}
			labelledBy={titleId}
			describedBy={bodyId}
			suspended={cryptoDialogOpen()}
			initialFocus={() => confirmRef}
			onKeyDown={handleKeyDown}
		>
			<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
				<h2 id={titleId} class="mb-2 text-lg font-semibold text-text-primary">
					{props.title}
				</h2>
				<div id={bodyId} class="mb-4 text-sm text-text-secondary">
					{props.body}
				</div>
				<Show when={error()}>
					<p
						class="mb-3 rounded bg-danger-bg/30 px-3 py-1.5 text-xs text-danger-text"
						role="alert"
					>
						{error()}
					</p>
				</Show>
				<div class="flex justify-end gap-2">
					<button
						type="button"
						onClick={tryClose}
						disabled={pending()}
						class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
					>
						{props.cancelLabel ?? "Cancel"}
					</button>
					<button
						type="button"
						ref={confirmRef}
						onClick={handleConfirm}
						disabled={pending()}
						class={
							props.destructive
								? "rounded bg-danger-bg px-4 py-2 text-sm font-semibold text-danger-text transition-colors hover:bg-danger-bg/80 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-danger-text disabled:cursor-not-allowed disabled:opacity-60"
								: "rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
						}
					>
						{pending()
							? (props.pendingLabel ?? "Working…")
							: (props.confirmLabel ?? "Confirm")}
					</button>
				</div>
			</div>
		</Modal>
	);
};

export { ConfirmDialog };
