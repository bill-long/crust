import {
	type Component,
	createSignal,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { isRecoveryKeyCancelled } from "../../../client/recoveryKeyCancelled";
import { userFacingErrorMessage } from "../../../lib/errorMessage";
import { EmojiDisplay } from "./EmojiDisplay";
import type { VerificationHandle } from "./useVerification";

interface VerificationDialogProps {
	verification: VerificationHandle;
	onClose: () => void;
	/**
	 * Verify this session with the recovery key instead of from another
	 * session. When given, the dialog opens on a choice between the two
	 * whenever the handle is idle (nothing started yet); the caller decides
	 * whether the option applies - it only makes sense for self-verification
	 * on an account whose cross-signing keys are in secret storage.
	 */
	verifyWithRecoveryKey?: () => Promise<void>;
}

type RecoveryStep = "idle" | "working" | "done" | "error";

/**
 * Modal dialog for SAS emoji verification. Shows the appropriate UI
 * for each verification state: waiting, emoji comparison, done, or error.
 * For self-verification it can also run the recovery-key route, which
 * lives outside the SAS handle: its own small step machine below.
 */
const VerificationDialog: Component<VerificationDialogProps> = (props) => {
	const v = props.verification;
	const [recoveryStep, setRecoveryStep] = createSignal<RecoveryStep>("idle");
	const [recoveryError, setRecoveryError] = createSignal("");
	let disposed = false;
	let dialogEl: HTMLDivElement | undefined;
	onCleanup(() => {
		disposed = true;
	});

	// The recovery route hands focus to the recovery-key prompt (a separate
	// overlay); when that unmounts, focus falls to the body unless something
	// takes it back. Only reclaim it when it was actually lost, so a user who
	// moved elsewhere meanwhile is not yanked back.
	const reclaimFocus = (): void => {
		const active = document.activeElement;
		if (!active || active === document.body) dialogEl?.focus();
	};

	const verifyWithRecoveryKey = async (): Promise<void> => {
		const run = props.verifyWithRecoveryKey;
		if (!run) return;
		setRecoveryStep("working");
		setRecoveryError("");
		try {
			await run();
			if (disposed) return;
			setRecoveryStep("done");
		} catch (e) {
			if (disposed) return;
			// Dismissing the key prompt is a change of mind, not a failure:
			// back to the choice.
			if (isRecoveryKeyCancelled(e)) {
				setRecoveryStep("idle");
				return;
			}
			console.error("Recovery-key verification failed:", e);
			setRecoveryError(
				userFacingErrorMessage(e, "Verification failed. Try again."),
			);
			setRecoveryStep("error");
		} finally {
			if (!disposed) reclaimFocus();
		}
	};

	// The recovery route can't be cancelled mid-way (the SDK is inside
	// bootstrap), so while its view is up the dialog stays open. Scoped to
	// the handle being idle: once an incoming SAS has taken the view over,
	// its own Done/Close must work regardless of the background import.
	const recoveryViewBusy = (): boolean =>
		recoveryStep() === "working" && v.state() === "idle";

	const canClose = (): boolean =>
		v.state() === "done" ||
		v.state() === "cancelled" ||
		v.state() === "error" ||
		v.state() === "idle";

	const handleClose = (): void => {
		// Must not fall through to v.cancel() either, which would mark the
		// untouched SAS handle cancelled.
		if (recoveryViewBusy()) return;
		if (canClose()) {
			v.reset();
			props.onClose();
		} else {
			v.cancel();
		}
	};

	return (
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			role="dialog"
			aria-modal="true"
			aria-label="Device verification"
			tabIndex={-1}
			ref={(el) => {
				dialogEl = el;
				el.focus();
			}}
			onClick={(e) => {
				if (e.target === e.currentTarget) handleClose();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") handleClose();
			}}
		>
			<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
				<Switch>
					{/* Waiting for other side */}
					<Match when={v.state() === "requested" || v.state() === "ready"}>
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							<h2 class="text-lg font-semibold text-text-primary">
								Waiting for the other device
							</h2>
							<p class="text-center text-sm text-text-muted">
								<Show
									when={v.isSelfVerification()}
									fallback="Accept the verification request on the other device."
								>
									Open your other session and accept the verification request.
								</Show>
							</p>
							<button
								type="button"
								onClick={() => v.cancel()}
								class="mt-2 rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Cancel
							</button>
						</div>
					</Match>

					{/* Emoji comparison */}
					<Match when={v.state() === "sas-showing"}>
						<h2 class="mb-4 text-center text-lg font-semibold text-text-primary">
							Compare emoji
						</h2>
						<p class="mb-6 text-center text-sm text-text-muted">
							Verify that the following emoji appear on both devices, in the
							same order.
						</p>

						<Show when={v.emoji()}>
							{(emojiList) => (
								<div class="mb-6 rounded-lg bg-surface-2/50 p-4">
									<EmojiDisplay emoji={emojiList()} />
								</div>
							)}
						</Show>

						<div class="flex justify-center gap-3">
							<button
								type="button"
								onClick={() => v.rejectSas()}
								class="rounded bg-danger-bg/50 px-4 py-2 text-sm font-medium text-danger-text-bright transition-colors hover:bg-danger-bg/70 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								They don't match
							</button>
							<button
								type="button"
								onClick={() => v.confirmSas()}
								class="rounded bg-success px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-success-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								They match
							</button>
						</div>
					</Match>

					{/* Confirming */}
					<Match when={v.state() === "sas-confirmed"}>
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-success-text" />
							<h2 class="text-lg font-semibold text-text-primary">
								Waiting for confirmation
							</h2>
							<p class="text-sm text-text-muted">
								Confirm the emoji on your other device too.
							</p>
						</div>
					</Match>

					{/* Done */}
					<Match when={v.state() === "done"}>
						<div class="flex flex-col items-center gap-4">
							<span class="text-4xl" role="img" aria-label="Verified">
								✅
							</span>
							<h2 class="text-lg font-semibold text-text-primary">
								Verification complete
							</h2>
							<p class="text-center text-sm text-text-muted">
								<Show
									when={v.isSelfVerification()}
									fallback="The device has been verified."
								>
									This session is now verified. Your devices trust each other.
								</Show>
							</p>
							<button
								type="button"
								onClick={handleClose}
								class="mt-2 rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Done
							</button>
						</div>
					</Match>

					{/* Cancelled */}
					<Match when={v.state() === "cancelled"}>
						<div class="flex flex-col items-center gap-4">
							<span class="text-4xl" role="img" aria-label="Cancelled">
								❌
							</span>
							<h2 class="text-lg font-semibold text-text-primary">
								Verification cancelled
							</h2>
							<p class="text-sm text-text-muted">
								The verification was cancelled.
							</p>
							<button
								type="button"
								onClick={handleClose}
								class="mt-2 rounded bg-surface-3 px-3 py-2 text-sm text-text-primary transition-colors hover:bg-surface-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Close
							</button>
						</div>
					</Match>

					{/* Error */}
					<Match when={v.state() === "error"}>
						<div class="flex flex-col items-center gap-4">
							<span class="text-4xl" role="img" aria-label="Error">
								⚠️
							</span>
							<h2 class="text-lg font-semibold text-text-primary">
								Verification failed
							</h2>
							<p class="text-sm text-danger-text-bright">{v.error()}</p>
							<button
								type="button"
								onClick={handleClose}
								class="mt-2 rounded bg-surface-3 px-3 py-2 text-sm text-text-primary transition-colors hover:bg-surface-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Close
							</button>
						</div>
					</Match>
					{/* Everything below is only reached while the SAS handle is idle:
					    the recovery-key route and the initial choice. An incoming
					    verification accepted mid-recovery binds the handle and takes
					    over the view above, rather than being hidden behind the
					    recovery spinner. */}
					{/* Recovery-key route: in flight */}
					<Match when={recoveryStep() === "working"}>
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							<h2 class="text-lg font-semibold text-text-primary">
								Verifying with your recovery key
							</h2>
							<p class="text-center text-sm text-text-muted">
								Enter your recovery key when prompted.
							</p>
						</div>
					</Match>

					{/* Recovery-key route: done */}
					<Match when={recoveryStep() === "done"}>
						<div class="flex flex-col items-center gap-4">
							<span class="text-4xl" role="img" aria-label="Verified">
								✅
							</span>
							<h2 class="text-lg font-semibold text-text-primary">
								Verification complete
							</h2>
							<p class="text-center text-sm text-text-muted">
								This session is now verified. Your devices trust each other.
							</p>
							<button
								type="button"
								onClick={handleClose}
								class="mt-2 rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Done
							</button>
						</div>
					</Match>

					{/* Recovery-key route: failed (wrong key, cancelled prompt) */}
					<Match when={recoveryStep() === "error"}>
						<div class="flex flex-col items-center gap-4">
							<span class="text-4xl" role="img" aria-label="Error">
								⚠️
							</span>
							<h2 class="text-lg font-semibold text-text-primary">
								Verification failed
							</h2>
							<p class="text-center text-sm text-danger-text-bright">
								{recoveryError()}
							</p>
							<div class="flex gap-3">
								<button
									type="button"
									onClick={handleClose}
									class="mt-2 rounded bg-surface-3 px-3 py-2 text-sm text-text-primary transition-colors hover:bg-surface-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
								>
									Close
								</button>
								<button
									type="button"
									onClick={() => setRecoveryStep("idle")}
									class="mt-2 rounded bg-accent px-3 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
								>
									Try again
								</button>
							</div>
						</div>
					</Match>

					{/* Nothing started yet: choose how to verify this session. The
					    caller opens here when the recovery key can verify; without
					    that route it starts the SAS request before opening, so the
					    handle is never idle at mount. */}
					<Match when={v.state() === "idle"}>
						<h2 class="mb-2 text-lg font-semibold text-text-primary">
							Verify this session
						</h2>
						<p class="mb-6 text-sm text-text-muted">
							Confirm from another session that's already verified by comparing
							emoji, or enter your recovery key.
						</p>
						<div class="flex flex-col gap-2">
							<button
								type="button"
								onClick={() => {
									// Starting the request swaps this button out of the view;
									// keep keyboard focus inside the dialog.
									v.requestSelfVerification();
									reclaimFocus();
								}}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Verify with another session
							</button>
							<Show when={props.verifyWithRecoveryKey}>
								<button
									type="button"
									onClick={verifyWithRecoveryKey}
									class="rounded bg-surface-3 px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
								>
									Use recovery key
								</button>
							</Show>
							<button
								type="button"
								onClick={handleClose}
								class="mt-2 rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Cancel
							</button>
						</div>
					</Match>
				</Switch>
			</div>
		</div>
	);
};

export { VerificationDialog };
