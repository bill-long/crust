import {
	type Component,
	createSignal,
	Match,
	onCleanup,
	Switch,
} from "solid-js";
import { useClient } from "../../client/client";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { trapTabKey } from "../../lib/focusTrap";
import { createUiaOverlayFocus, UiaPrompts } from "./UiaDialog";
import { createUiaFlow, UiaCancelledError } from "./uiaFlow";

type SetupStep = "intro" | "working" | "done" | "error";

interface CrossSigningSetupProps {
	onClose: () => void;
}

/**
 * Dialog for bootstrapping cross-signing on this account. This is the
 * first-device setup flow: creates master, self-signing, and user-signing
 * keys, then uploads them with UIA.
 */
export const CrossSigningSetup: Component<CrossSigningSetupProps> = (props) => {
	const { client, cryptoStatus, clearSecretStorageCache } = useClient();

	const [step, setStep] = createSignal<SetupStep>("intro");
	const [errorMessage, setErrorMessage] = createSignal("");

	// Interactive UIA: the server decides whether the user re-enters a
	// password or approves at the account-management page (#467). The
	// preflight collects that before the bootstrap starts, so cancelling
	// at a prompt backs out with the account untouched.
	const uia = createUiaFlow(client);
	let disposed = false;
	// Non-destructive preflight vs the actual bootstrap (see the same
	// split in ResetEncryptionDialog).
	let phase: "preflight" | "op" | null = null;
	onCleanup(() => {
		disposed = true;
		uia.cancel();
	});

	const doBootstrap = async (): Promise<void> => {
		const crypto = client.getCrypto();
		if (!crypto) {
			setErrorMessage("Encryption is not available.");
			setStep("error");
			return;
		}

		if (!client.getUserId()) {
			setErrorMessage("Unable to determine user ID.");
			setStep("error");
			return;
		}

		setErrorMessage("");
		setStep("working");

		phase = "preflight";
		try {
			await uia.preflight();
		} catch (e) {
			phase = null;
			if (disposed) return;
			if (e instanceof UiaCancelledError) {
				setStep("intro");
				return;
			}
			console.error("Cross-signing preflight failed:", e);
			setErrorMessage(
				userFacingErrorMessage(e, "Setup failed. Please try again."),
			);
			setStep("error");
			return;
		}
		phase = "op";
		// Unmounted or dismissed while the probe was in flight: don't start
		// a bootstrap nobody is watching.
		if (disposed) return;

		try {
			await crypto.bootstrapCrossSigning({
				authUploadDeviceSigningKeys: uia.uiaCallback,
			});

			await cryptoStatus.refresh();
			if (disposed) return;
			setStep("done");
		} catch (e) {
			// A partial bootstrap may already have minted local keys and
			// cached 4S material - drop the cache on every failure path,
			// including after an unmount.
			clearSecretStorageCache();
			if (disposed) return;
			if (e instanceof UiaCancelledError) {
				// The bootstrap has already minted new local signing keys by
				// the time its upload is refused, and a bare retry would not
				// re-upload them (SDK quirk) - surface the interruption
				// instead of silently stepping back as if nothing ran.
				setErrorMessage(
					"Setup was interrupted before the server confirmed your identity. Run it again to finish.",
				);
				setStep("error");
				return;
			}
			console.error("Cross-signing bootstrap failed:", e);
			setErrorMessage(
				userFacingErrorMessage(e, "Setup failed. Please try again."),
			);
			setStep("error");
		} finally {
			phase = null;
		}
	};

	const startSetup = (): void => {
		void doBootstrap();
	};

	// Focus contract: identity prompts focus their own primary control;
	// the overlay reclaims focus lost to promptless view swaps (see
	// createUiaOverlayFocus).
	let overlayEl!: HTMLDivElement;
	createUiaOverlayFocus({ flow: uia, overlay: () => overlayEl, step });

	// Backdrop click / Escape: a pending identity prompt steps back to the
	// intro (via the flow's cancel rejection); the destructive phase blocks
	// dismissal, but a preflight still probing the network does not (see
	// ResetEncryptionDialog's dismiss for the reasoning).
	const onDismiss = (): void => {
		if (uia.prompt()) {
			uia.cancel();
			return;
		}
		if (step() === "working") {
			if (phase === "preflight") {
				uia.cancel();
				props.onClose();
			}
			return;
		}
		props.onClose();
	};

	return (
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			role="dialog"
			aria-modal="true"
			aria-label="Set up secure messaging"
			tabIndex={-1}
			ref={overlayEl}
			onClick={(e) => {
				if (e.target === e.currentTarget) onDismiss();
			}}
			onKeyDown={(e) => {
				if (e.key === "Tab") {
					trapTabKey(overlayEl, e);
					return;
				}
				if (e.key === "Escape") onDismiss();
			}}
		>
			{/* The identity prompts render while step() is "working" - the
			    flow suspends mid-bootstrap - so their matches shadow the
			    spinner while a prompt is pending. */}
			<Switch>
				<Match when={step() === "intro"}>
					<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-3 text-lg font-semibold text-text-primary">
							Set up secure messaging
						</h2>
						<p class="mb-2 text-sm text-text-secondary">
							Cross-signing lets you verify your devices and other users. Once
							set up, your devices can trust each other and you can read
							encrypted messages across all your sessions.
						</p>
						<p class="mb-6 text-sm text-text-muted">
							You may be asked to confirm your identity to complete this step.
						</p>
						<div class="flex justify-end gap-2">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Later
							</button>
							<button
								type="button"
								onClick={startSetup}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Continue
							</button>
						</div>
					</div>
				</Match>

				<Match when={uia.prompt()}>
					<UiaPrompts flow={uia} />
				</Match>

				<Match when={step() === "working"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							<p class="text-sm text-text-secondary">
								Setting up cross-signing…
							</p>
						</div>
					</div>
				</Match>

				<Match when={step() === "done"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<div class="mb-4 text-center">
							<span class="text-4xl" role="img" aria-label="Success">
								✅
							</span>
						</div>
						<h2 class="mb-2 text-center text-lg font-semibold text-text-primary">
							Secure messaging is set up
						</h2>
						<p class="mb-6 text-center text-sm text-text-muted">
							Your cross-signing keys have been created. You can now verify your
							other devices.
						</p>
						<div class="flex justify-center">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Done
							</button>
						</div>
					</div>
				</Match>

				<Match when={step() === "error"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-2 text-lg font-semibold text-text-primary">
							Setup failed
						</h2>
						<p class="mb-4 text-sm text-danger-text-bright">{errorMessage()}</p>
						<div class="flex justify-end gap-2">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Close
							</button>
							<button
								type="button"
								onClick={startSetup}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Try again
							</button>
						</div>
					</div>
				</Match>
			</Switch>
		</div>
	);
};
