import {
	type Component,
	createEffect,
	createUniqueId,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { containFocusWhileOpen } from "../../lib/focusTrap";
import { cryptoDialogOpen } from "../../stores/cryptoActions";
import { trackAppModalOpen } from "../../stores/modalStack";

const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface CopyLinkFallbackDialogProps {
	/**
	 * The text to display (a link, or any other text the user asked to
	 * copy). Snapshot taken at open time by the caller so the dialog keeps
	 * showing the text the user asked to copy even if the underlying room
	 * changes.
	 */
	text: string;
	/** Heading text. Defaults to "Copy room link". */
	title?: string;
	/** Accessible label for the readonly link input. Defaults to "Room link". */
	inputLabel?: string;
	/** Body text. Defaults to the link-flavored explanation. */
	description?: string;
	/**
	 * Render the text in a readonly textarea instead of a single-line
	 * input. Text containing a newline always gets the textarea - an
	 * `<input>` value cannot hold newlines, so copying from one would
	 * silently lose them - so this only forces the textarea for callers
	 * whose single-line text should still render multiline-style.
	 */
	multiline?: boolean;
	open: () => boolean;
	onClose: () => void;
}

const CopyLinkFallbackDialog: Component<CopyLinkFallbackDialogProps> = (
	props,
) => {
	trackAppModalOpen(props.open);
	let overlayRef!: HTMLDivElement;
	let inputRef: HTMLInputElement | HTMLTextAreaElement | undefined;
	let previousFocus: HTMLElement | null = null;

	const titleId = createUniqueId();
	const descId = createUniqueId();

	// Shared by the input and textarea branches so the two can't drift.
	const fieldClass =
		"mb-4 w-full rounded bg-surface-2 px-3 py-2 font-mono text-xs text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover";
	const setFieldRef = (el: HTMLInputElement | HTMLTextAreaElement): void => {
		inputRef = el;
	};
	const selectField = (e: {
		currentTarget: HTMLInputElement | HTMLTextAreaElement;
	}): void => e.currentTarget.select();

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

	// An opener can asynchronously restore focus to itself after the dialog
	// took its initial focus (Kobalte's dropdown refocuses its trigger on a
	// timer after unmount - the "Copy text" path), which would strand the
	// overlay-scoped Escape/Tab handling. Recapture while open.
	containFocusWhileOpen(
		props.open,
		() => overlayRef,
		() => inputRef,
	);

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
			if (!first || !last) return;
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
						{props.title ?? "Copy room link"}
					</h2>
					<p id={descId} class="mb-3 text-sm text-text-muted">
						{props.description ??
							"Your browser blocked clipboard access. Select the link and copy it manually."}
					</p>
					<Show
						when={props.multiline || props.text.includes("\n")}
						fallback={
							<input
								ref={setFieldRef}
								type="text"
								readOnly
								value={props.text}
								aria-label={props.inputLabel ?? "Room link"}
								onFocus={selectField}
								class={fieldClass}
							/>
						}
					>
						<textarea
							ref={setFieldRef}
							readOnly
							value={props.text}
							rows={4}
							aria-label={props.inputLabel ?? "Room link"}
							onFocus={selectField}
							class={`${fieldClass} resize-none`}
						/>
					</Show>
					<div class="flex justify-end">
						<button
							type="button"
							onClick={props.onClose}
							class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
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
