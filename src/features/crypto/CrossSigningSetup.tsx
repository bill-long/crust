import { type Component, createSignal, Match, Switch } from "solid-js";
import { useClient } from "../../client/client";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { trapTabKey } from "../../lib/focusTrap";
import { createUiaOverlayFocus, UiaPrompts } from "./UiaDialog";
import { createUiaDialogFlow } from "./uiaDialogFlow";

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
	// at a prompt backs out with the account untouched. The dialog
	// lifecycle around it - unmount tracking, which half is in flight,
	// the dismissal policy - lives in createUiaDialogFlow (#545).
	const uia = createUiaDialogFlow(client);

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

		const fail = (error: unknown, logLabel: string): void => {
			console.error(logLabel, error);
			setErrorMessage(
				userFacingErrorMessage(error, "Setup failed. Please try again."),
			);
			setStep("error");
		};

		const preflight = await uia.preflight();
		// Unmounted or dismissed while the probe was in flight: don't touch
		// the UI, and don't start a bootstrap nobody is watching. Nothing
		// between here and `run` awaits, so this one check covers both.
		if (uia.disposed()) return;
		if (preflight.status === "cancelled") {
			setStep("intro");
			return;
		}
		if (preflight.status === "failed") {
			fail(preflight.error, "Cross-signing preflight failed:");
			return;
		}
		const done = await uia.run(async () => {
			await crypto.bootstrapCrossSigning({
				authUploadDeviceSigningKeys: uia.flow.uiaCallback,
			});
			await cryptoStatus.refresh();
		});
		if (done.status !== "ok") {
			// A partial bootstrap may already have minted local keys and
			// cached 4S material - drop the cache on every failure path,
			// including after an unmount.
			clearSecretStorageCache();
		}
		if (uia.disposed()) return;
		if (done.status === "ok") {
			setStep("done");
			return;
		}
		if (done.status === "cancelled") {
			// The bootstrap has already minted new local signing keys by the
			// time its upload is refused, and a bare retry would not
			// re-upload them (SDK quirk) - surface the interruption instead
			// of silently stepping back as if nothing ran.
			setErrorMessage(
				"Setup was interrupted before the server confirmed your identity. Run it again to finish.",
			);
			setStep("error");
			return;
		}
		fail(done.error, "Cross-signing bootstrap failed:");
	};

	const startSetup = (): void => {
		void doBootstrap();
	};

	// Focus contract: identity prompts focus their own primary control;
	// the overlay reclaims focus lost to promptless view swaps (see
	// createUiaOverlayFocus).
	let overlayEl!: HTMLDivElement;
	createUiaOverlayFocus({ flow: uia.flow, overlay: () => overlayEl, step });

	// Backdrop click / Escape: the shared policy (see UiaDialogFlow.dismiss).
	// Cancelling a pending prompt rejects the flow and lands in
	// doBootstrap's cancelled branch - the intro during the preflight, the
	// "interrupted" error once the bootstrap has started. The bootstrap
	// blocks dismissal; the preflight probe does not.
	const onDismiss = (): void => uia.dismiss(props.onClose);

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

				<Match when={uia.flow.prompt()}>
					<UiaPrompts flow={uia.flow} />
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
