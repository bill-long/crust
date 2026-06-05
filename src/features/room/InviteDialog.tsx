import type { MatrixClient } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { cryptoDialogOpen } from "../../stores/cryptoActions";
import { trackAppModalOpen } from "../../stores/modalStack";
import { CopyLinkFallbackDialog } from "./CopyLinkFallbackDialog";
import { buildRoomLink, buildRoomLinkById, canShareJoinLink } from "./roomLink";
import { InviteByUserIdForm } from "./settings/InviteByUserIdForm";
import { useRoomStateContent } from "./settings/useRoomStateContent";
import { createCopyLink } from "./useCopyLink";

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
	/**
	 * Whether the invite target is a regular room or a space. Drives
	 * user-facing copy only (the SDK call is identical). Defaults to
	 * "room". Caller should snapshot this at open time alongside roomId
	 * so the dialog header cannot drift mid-dialog.
	 */
	kind?: "room" | "space";
	open: () => boolean;
	onClose: () => void;
}

const InviteDialog: Component<InviteDialogProps> = (props) => {
	trackAppModalOpen(props.open);
	let overlayRef!: HTMLDivElement;
	let inputRef: HTMLInputElement | undefined;
	let previousFocus: HTMLElement | null = null;

	const [submitting, setSubmitting] = createSignal(false);
	const [resetTick, setResetTick] = createSignal(0);

	const titleId = createUniqueId();

	const joinRules = useRoomStateContent<{ join_rule?: string }>(
		props.client,
		() => props.roomId,
		"m.room.join_rules",
	);
	const canShareLink = createMemo(() =>
		canShareJoinLink(joinRules()?.join_rule),
	);

	const copyLink = createCopyLink();
	const inviteUrl = (): string => {
		const room = props.client.getRoom(props.roomId);
		// Prefer the canonical alias / via-hinted link from the loaded Room;
		// fall back to a minimal link from the ID if it hasn't synced yet.
		return room ? buildRoomLink(room).url : buildRoomLinkById(props.roomId).url;
	};
	const copyLabel = (): string => {
		switch (copyLink.copyState()) {
			case "copied":
				return "Invite link copied!";
			case "error":
				return "Copy failed";
			default:
				return "Copy invite link";
		}
	};

	// Closing the dialog should drop any lingering copy feedback / fallback so
	// it can't reappear the next time the dialog opens for another target.
	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (!isOpen && wasOpen) copyLink.reset();
		}),
	);

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
		<>
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
						<h2
							id={titleId}
							class="mb-3 text-lg font-semibold text-text-primary"
						>
							Invite to {props.kind ?? "room"}
						</h2>

						<Show when={canShareLink()}>
							<div class="mb-4">
								<p class="mb-2 text-sm text-text-muted">
									Share a link so people can join this {props.kind ?? "room"}.
								</p>
								<button
									type="button"
									onClick={() => void copyLink.copy(inviteUrl())}
									class="inline-flex items-center gap-2 rounded bg-surface-2 px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover any-pointer-coarse:min-h-11 any-pointer-coarse:py-3"
									classList={{
										"text-success-text": copyLink.copyState() === "copied",
										"text-danger-text": copyLink.copyState() === "error",
										"text-text-primary": copyLink.copyState() === "idle",
									}}
								>
									<Show
										when={copyLink.copyState() === "copied"}
										fallback={
											<svg
												class="h-4 w-4"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												stroke-linecap="round"
												stroke-linejoin="round"
												aria-hidden="true"
											>
												<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
												<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
											</svg>
										}
									>
										<svg
											class="h-4 w-4"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
											stroke-linejoin="round"
											aria-hidden="true"
										>
											<polyline points="20 6 9 17 4 12" />
										</svg>
									</Show>
									{copyLabel()}
								</button>
								<span aria-live="polite" role="status" class="sr-only">
									{copyLink.copyState() === "copied"
										? "Invite link copied to clipboard"
										: copyLink.copyState() === "error"
											? "Failed to copy invite link"
											: ""}
								</span>
							</div>
						</Show>

						<p class="mb-4 text-sm text-text-muted">
							Enter a Matrix user ID to invite to this {props.kind ?? "room"}.
						</p>

						<InviteByUserIdForm
							client={props.client}
							roomId={props.roomId}
							kind={props.kind ?? "room"}
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

			{/* Clipboard-unavailable fallback for "Copy invite link". Rendered as
				a sibling (mirroring Layout) so its own focus trap and key
				handlers don't fight the invite dialog's. */}
			<Show when={copyLink.fallbackLink()}>
				{(url) => (
					<CopyLinkFallbackDialog
						url={url()}
						title="Copy invite link"
						inputLabel="Invite link"
						open={() => copyLink.fallbackLink() !== null}
						onClose={() => copyLink.clearFallback()}
					/>
				)}
			</Show>
		</>
	);
};

export { InviteDialog };
