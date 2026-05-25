import {
	type Component,
	createEffect,
	createSignal,
	createUniqueId,
	type JSX,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { cryptoDialogOpen } from "../../../stores/cryptoActions";

const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
 * Generic destructive confirm modal. Mirrors `InviteDialog`'s focus
 * trap + Esc + restore-focus behavior so all overlays in this surface
 * feel identical.
 *
 * Used for: Leave room (header + Advanced tab), Kick…, Ban…, and the
 * "Anyone can change state" PL preset confirm.
 */
const ConfirmDialog: Component<ConfirmDialogProps> = (props) => {
	let overlayRef!: HTMLDivElement;
	let confirmRef: HTMLButtonElement | undefined;
	let previousFocus: HTMLElement | null = null;

	const [pending, setPending] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	const titleId = createUniqueId();
	const bodyId = createUniqueId();

	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				previousFocus = document.activeElement as HTMLElement | null;
				setPending(false);
				setError(null);
				queueMicrotask(() => confirmRef?.focus());
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
		if (pending()) return;
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
		<Show when={props.open()}>
			<div
				ref={overlayRef}
				class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={bodyId}
				inert={cryptoDialogOpen() || undefined}
				tabIndex={-1}
				onKeyDown={handleKeyDown}
				onClick={(e) => {
					if (e.target === e.currentTarget) tryClose();
				}}
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
							class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
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
									? "rounded bg-danger-bg px-4 py-2 text-sm font-semibold text-danger-text transition-colors hover:bg-danger-bg/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger-text disabled:cursor-not-allowed disabled:opacity-60"
									: "rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
							}
						>
							{pending()
								? (props.pendingLabel ?? "Working…")
								: (props.confirmLabel ?? "Confirm")}
						</button>
					</div>
				</div>
			</div>
		</Show>
	);
};

export { ConfirmDialog };
