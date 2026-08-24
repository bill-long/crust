import type { MatrixEvent } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createUniqueId,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { containFocusWhileOpen, trapTabKey } from "../../../lib/focusTrap";
import { cryptoDialogOpen } from "../../../stores/cryptoActions";
import { trackAppModalOpen } from "../../../stores/modalStack";
import type { TimelineEvent } from "./timelineTypes";

interface ViewSourceDialogProps {
	/** The message whose source to show; non-null while the dialog is open. */
	target: () => TimelineEvent | null;
	roomId: () => string;
	/** Resolve the raw SDK event for a timeline row. */
	getSourceEvent: (eventId: string) => MatrixEvent | undefined;
	onClose: () => void;
}

function pretty(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/**
 * Read-only raw-event viewer (Element devtools style, #447). Shows the
 * decrypted event JSON (`getEffectiveEvent()` - the event as it would have
 * looked unencrypted, which for an edited message is the original event
 * plus the SDK's replacement bookkeeping), and for encrypted events also
 * the wire-format `m.room.encrypted` envelope.
 */
const ViewSourceDialog: Component<ViewSourceDialogProps> = (props) => {
	const open = () => props.target() !== null;
	trackAppModalOpen(open);

	let overlayRef!: HTMLDivElement;
	let closeRef: HTMLButtonElement | undefined;
	let previousFocus: HTMLElement | null = null;
	const titleId = createUniqueId();

	createEffect(
		on(open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				previousFocus = document.activeElement as HTMLElement | null;
				queueMicrotask(() => closeRef?.focus());
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

	containFocusWhileOpen(
		open,
		() => overlayRef,
		() => closeRef,
	);

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape") {
			e.stopPropagation();
			props.onClose();
			return;
		}
		if (e.key === "Tab") {
			trapTabKey(overlayRef, e);
		}
	};

	const sourceEvent = () => {
		const target = props.target();
		return target ? props.getSourceEvent(target.eventId) : undefined;
	};

	return (
		<Show when={props.target()}>
			{(target) => (
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
						if (e.target === e.currentTarget) props.onClose();
					}}
				>
					<div class="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2
							id={titleId}
							class="mb-2 text-lg font-semibold text-text-primary"
						>
							Message source
						</h2>
						<p class="mb-3 break-all text-xs text-text-muted">
							{props.roomId()} · {target().eventId}
						</p>
						<div class="min-h-0 flex-1 overflow-y-auto">
							<Show
								when={sourceEvent()}
								fallback={
									<p class="text-sm text-text-muted">
										The original event is no longer available.
									</p>
								}
							>
								{(event) => (
									<>
										<pre class="overflow-x-auto rounded bg-surface-2 p-3 text-xs text-text-secondary">
											{pretty(event().getEffectiveEvent())}
										</pre>
										<Show when={event().isEncrypted()}>
											<h3 class="mb-1 mt-3 text-xs font-semibold uppercase tracking-wider text-text-disabled">
												Encrypted wire event
											</h3>
											<pre class="overflow-x-auto rounded bg-surface-2 p-3 text-xs text-text-secondary">
												{pretty(event().event)}
											</pre>
										</Show>
									</>
								)}
							</Show>
						</div>
						<div class="mt-4 flex justify-end">
							<button
								type="button"
								ref={closeRef}
								onClick={props.onClose}
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Close
							</button>
						</div>
					</div>
				</div>
			)}
		</Show>
	);
};

export { ViewSourceDialog };
