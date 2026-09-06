import { type Component, createUniqueId, Show } from "solid-js";
import { Modal } from "../../components/Modal";
import { cryptoDialogOpen } from "../../stores/cryptoActions";

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
	let inputRef: HTMLInputElement | HTMLTextAreaElement | undefined;

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

	return (
		<Modal
			open={props.open()}
			onClose={props.onClose}
			labelledBy={titleId}
			describedBy={descId}
			suspended={cryptoDialogOpen()}
			initialFocus={() => inputRef}
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
		</Modal>
	);
};

export { CopyLinkFallbackDialog };
