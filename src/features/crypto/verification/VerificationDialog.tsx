import {
	type Component,
	createEffect,
	createSignal,
	Match,
	on,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { isRecoveryKeyCancelled } from "../../../client/recoveryKeyCancelled";
import { Modal } from "../../../components/Modal";
import { userFacingErrorMessage } from "../../../lib/errorMessage";
import { EmojiDisplay } from "./EmojiDisplay";
import { QrCodeDisplay } from "./QrCodeDisplay";
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
	verifyWithRecoveryKey?: (() => Promise<void>) | undefined;
}

type RecoveryStep = "idle" | "working" | "done" | "error";

/**
 * Modal dialog for interactive device verification. Shows the appropriate UI
 * for each verification state: waiting, a QR code for the other device to
 * scan, the confirmation prompt once it has scanned, emoji comparison, done,
 * or error. For self-verification it can also run the recovery-key route,
 * which lives outside the verification handle: its own small step machine
 * below.
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

	// Most view swaps here are driven by the *other* device, not by a local
	// click: it accepts, it scans, it confirms. Whatever the user had focused
	// unmounts underneath them and focus falls to the body, which costs them
	// Escape (the handler lives on the container and only sees bubbled keys)
	// and Tab (the content behind the dialog is inert). reclaimFocus only
	// acts when focus was genuinely lost, so a user who moved elsewhere in
	// the meantime is left alone.
	createEffect(on(v.state, reclaimFocus, { defer: true }));

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
		<Modal
			open
			onClose={handleClose}
			label="Device verification"
			initialFocus={() => dialogEl}
			contentRef={(element) => {
				dialogEl = element;
			}}
		>
			<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
				<Switch>
					{/* Sent, waiting for the other side to accept */}
					<Match when={v.state() === "requested"}>
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

					{/* Accepted; settling on a method. Separate from `requested`
					    because that view tells the user to go accept the request,
					    which they already have: this covers both building the QR
					    code and starting emoji from "Can't scan?". */}
					<Match when={v.state() === "ready"}>
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							<h2 class="text-lg font-semibold text-text-primary">
								Setting up verification
							</h2>
							<p class="text-center text-sm text-text-muted">
								This will only take a moment.
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

					{/* Our QR code, waiting for the other device to scan it */}
					<Match when={v.state() === "qr-showing"}>
						<h2 class="mb-2 text-center text-lg font-semibold text-text-primary">
							Scan this code
						</h2>
						<p class="mb-4 text-center text-sm text-text-muted">
							<Show
								when={v.isSelfVerification()}
								fallback="Ask them to scan this code from their session."
							>
								Scan this code from your other session to verify this one.
							</Show>
						</p>

						<div class="mb-6 flex justify-center">
							<Show when={v.qrBytes()}>
								{(bytes) => (
									<QrCodeDisplay bytes={bytes()} label="Verification QR code" />
								)}
							</Show>
						</div>

						<div class="flex justify-center gap-3">
							<button
								type="button"
								onClick={() => v.cancel()}
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={() => v.startSas()}
								class="rounded bg-surface-3 px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Can't scan? Compare emoji
							</button>
						</div>
					</Match>

					{/* The other device scanned our code and is waiting on us */}
					<Match when={v.state() === "qr-reciprocate"}>
						<h2 class="mb-4 text-center text-lg font-semibold text-text-primary">
							Confirm the scan
						</h2>
						<p class="mb-6 text-center text-sm text-text-muted">
							<Show
								when={v.isSelfVerification()}
								fallback="Their session scanned the code. Confirm only if it reports the verification succeeded."
							>
								Your other session scanned the code. Confirm only if it reports
								the verification succeeded.
							</Show>
						</p>

						<div class="flex justify-center gap-3">
							<button
								type="button"
								onClick={() => v.rejectQr()}
								class="rounded bg-danger-bg/50 px-4 py-2 text-sm font-medium text-danger-text-bright transition-colors hover:bg-danger-bg/70 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								No
							</button>
							<button
								type="button"
								onClick={() => v.confirmQr()}
								class="rounded bg-success px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-success-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Yes
							</button>
						</div>
					</Match>

					{/* Scan confirmed; waiting for the other side's m.key.verification.done */}
					<Match when={v.state() === "qr-confirmed"}>
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-success-text" />
							<h2 class="text-lg font-semibold text-text-primary">
								Finishing verification
							</h2>
							<p class="text-sm text-text-muted">
								Waiting for the other device.
							</p>
							{/* Confirming a scan is fire-and-forget: the SDK's
							    ShowQrCodeCallbacks.confirm() returns void and drops
							    the promise its send runs on, so a failed `done`
							    becomes an unhandled rejection rather than something
							    the dialog can report. Unlike the emoji route there is
							    no error to show, so without this the spinner is a
							    dead end.
							    The exit is not free: our `done` is already sent, so
							    cancelling here can leave the other device trusting us
							    while we do not trust it. A stuck spinner with no way
							    out is the worse of the two, but if this ever needs
							    revisiting, that asymmetry is the cost. */}
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
							Confirm from another session that's already verified, or enter
							your recovery key.
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
		</Modal>
	);
};

export { VerificationDialog };
