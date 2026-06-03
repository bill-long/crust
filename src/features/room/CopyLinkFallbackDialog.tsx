import {
	type Component,
	createEffect,
	createUniqueId,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { cryptoDialogOpen } from "../../stores/cryptoActions";
import { trackAppModalOpen } from "../../stores/modalStack";

const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface CopyLinkFallbackDialogProps {
	/**
	 * The link to display. Snapshot taken at open time by the caller so the
	 * dialog keeps showing the link the user asked to copy even if the
	 * underlying room changes.
	 */
	url: string;
	open: () => boolean;
	onClose: () => void;
}

const CopyLinkFallbackDialog: Component<CopyLinkFallbackDialogProps> = (
	props,
) => {
	trackAppModalOpen(props.open);
	let overlayRef!: HTMLDivElement;
	let inputRef: HTMLInputElement | undefined;
	let previousFocus: HTMLElement | null = null;

	const titleId = createUniqueId();
	const descId = createUniqueId();

	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				previousFocus = document.activeElement as HTMLElement | null;
				queueMicrotask(() => {
					inputRef?.focus();
					inputRef?.select();
				});
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

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape") {
			e.stopPropagation();
			props.onClose();
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
				aria-describedby={descId}
				inert={cryptoDialogOpen() || undefined}
				tabIndex={-1}
				onKeyDown={handleKeyDown}
				onClick={(e) => {
					if (e.target === e.currentTarget) props.onClose();
				}}
			>
				<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
					<h2 id={titleId} class="mb-2 text-lg font-semibold text-text-primary">
						Copy room link
					</h2>
					<p id={descId} class="mb-3 text-sm text-text-muted">
						Your browser blocked clipboard access. Select the link and copy it
						manually.
					</p>
					<input
						ref={inputRef}
						type="text"
						readOnly
						value={props.url}
						aria-label="Room link"
						onFocus={(e) => e.currentTarget.select()}
						class="mb-4 w-full rounded bg-surface-2 px-3 py-2 font-mono text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
					/>
					<div class="flex justify-end">
						<button
							type="button"
							onClick={props.onClose}
							class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
						>
							Close
						</button>
					</div>
				</div>
			</div>
		</Show>
	);
};

export { CopyLinkFallbackDialog };
