import type { GeneratedSecretStorageKey } from "matrix-js-sdk/lib/crypto-api";
import {
	type Component,
	createSignal,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { useClient } from "../../../client/client";
import {
	activateExistingKeyBackup,
	ensureKeyBackup,
	fetchServerKeyBackup,
} from "./keyBackupSetup";
import { RecoveryKeyDisplay } from "./RecoveryKeyDisplay";

type SetupStep =
	| "intro"
	| "working"
	| "show-key"
	| "done"
	| "restore-needed"
	| "error";

interface BackupSetupDialogProps {
	onClose: () => void;
}

/**
 * Wizard dialog for setting up key backup + secret storage.
 * Flow: intro → working → show-key → done (or error at any point). When a
 * server backup already exists but can't be activated on this device, the
 * flow routes to restore-needed instead of a false "done".
 *
 * Secret storage is reused if it already exists: the SDK only calls
 * createSecretStorageKey (minting a new recovery key) when no storage exists,
 * so the "show recovery key" step is skipped on reuse. An existing key backup
 * is likewise reused rather than reset (see ensureKeyBackup).
 */
const BackupSetupDialog: Component<BackupSetupDialogProps> = (props) => {
	const { client, cryptoStatus, clearSecretStorageCache } = useClient();

	const [step, setStep] = createSignal<SetupStep>("intro");
	const [recoveryKey, setRecoveryKey] = createSignal<string | undefined>();
	const [errorMessage, setErrorMessage] = createSignal("");
	// A backup exists but isn't active yet — the user must still unlock it even
	// after a freshly minted recovery key has been shown.
	const [restorePending, setRestorePending] = createSignal(false);
	let disposed = false;

	onCleanup(() => {
		disposed = true;
	});

	const doSetup = async (): Promise<void> => {
		const crypto = client.getCrypto();
		if (!crypto) {
			setErrorMessage("Encryption is not available.");
			setStep("error");
			return;
		}

		setStep("working");
		setErrorMessage("");

		try {
			let generatedKey: GeneratedSecretStorageKey | undefined;

			// Reuse existing secret storage and an existing key backup; only mint
			// a new recovery key / key backup when none exists. Never force new
			// secret storage or reset the backup — that would supersede recoverable
			// secrets on every run (see ensureKeyBackup). fetchServerKeyBackup
			// throws on an uncertain check so we never reset on a transient error.
			const result = await ensureKeyBackup(
				crypto,
				async () => {
					const key = await crypto.createRecoveryKeyFromPassphrase();
					generatedKey = key;
					return key;
				},
				() => fetchServerKeyBackup(client),
			);

			if (disposed) return;

			await cryptoStatus.refresh();
			if (disposed) return;

			const needsRestore = result.outcome === "needs-restore";
			setRestorePending(needsRestore);

			if (generatedKey?.encodedPrivateKey) {
				// A new recovery key was minted — always show it (cross-signing
				// secrets are stored under it and would be unrecoverable otherwise),
				// even if an existing backup still needs unlocking afterwards.
				setRecoveryKey(generatedKey.encodedPrivateKey);
				setStep("show-key");
			} else if (needsRestore) {
				// A backup exists on the server but isn't active on this device.
				// Don't claim success — route to the restore/unlock flow.
				setStep("restore-needed");
			} else {
				// Secret storage already existed; backup created/reused with it.
				setStep("done");
			}
		} catch (e) {
			if (disposed) return;
			console.error("Key backup setup failed:", e);
			clearSecretStorageCache();
			setErrorMessage(
				e instanceof Error ? e.message : "Setup failed. Please try again.",
			);
			setStep("error");
		}
	};

	const doRestore = async (): Promise<void> => {
		const crypto = client.getCrypto();
		if (!crypto) {
			setErrorMessage("Encryption is not available.");
			setStep("error");
			return;
		}

		setStep("working");
		setErrorMessage("");

		try {
			const activated = await activateExistingKeyBackup(crypto);
			if (disposed) return;

			await cryptoStatus.refresh();
			if (disposed) return;

			if (activated) {
				setRestorePending(false);
				setStep("done");
			} else {
				clearSecretStorageCache();
				setErrorMessage(
					"Couldn't unlock the existing key backup. Check your recovery key and try again.",
				);
				setStep("restore-needed");
			}
		} catch (e) {
			if (disposed) return;
			console.error("Key backup restore failed:", e);
			clearSecretStorageCache();
			setErrorMessage(
				e instanceof Error ? e.message : "Restore failed. Please try again.",
			);
			setStep("restore-needed");
		}
	};

	const isBusy = (): boolean => step() === "working";

	const handleBackdropClick = (e: MouseEvent): void => {
		if (e.target === e.currentTarget && !isBusy()) {
			if (step() === "show-key") return; // Don't dismiss while showing key
			props.onClose();
		}
	};

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape" && !isBusy() && step() !== "show-key") {
			props.onClose();
		}
	};

	return (
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			role="dialog"
			aria-modal="true"
			aria-label="Set up key backup"
			tabIndex={-1}
			ref={(el) => el.focus()}
			onClick={handleBackdropClick}
			onKeyDown={handleKeyDown}
		>
			<Switch>
				{/* Intro */}
				<Match when={step() === "intro"}>
					<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-3 text-lg font-semibold text-text-primary">
							Set up key backup
						</h2>
						<p class="mb-2 text-sm text-text-secondary">
							Key backup stores your encrypted message keys on the server so you
							can access your message history from any device.
						</p>
						<p class="mb-6 text-sm text-text-muted">
							You'll receive a recovery key — save it somewhere safe. You'll
							need it if you lose access to all your devices.
						</p>
						<div class="flex justify-end gap-2">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
							>
								Later
							</button>
							<button
								type="button"
								onClick={doSetup}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover"
							>
								Continue
							</button>
						</div>
					</div>
				</Match>

				{/* Working */}
				<Match when={step() === "working"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							<p class="text-sm text-text-secondary">Setting up key backup…</p>
						</div>
					</div>
				</Match>

				{/* Show recovery key */}
				<Match when={step() === "show-key"}>
					<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-3 text-lg font-semibold text-text-primary">
							Save your recovery key
						</h2>
						<p class="mb-4 text-sm text-text-muted">
							Store this key somewhere safe. You'll need it to recover your
							encrypted messages if you lose access to all your devices.
						</p>

						<Show when={recoveryKey()}>
							{(key) => <RecoveryKeyDisplay recoveryKey={key()} />}
						</Show>

						<div class="flex justify-end">
							<button
								type="button"
								onClick={() => {
									setStep(restorePending() ? "restore-needed" : "done");
								}}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover"
							>
								I've saved my key
							</button>
						</div>
					</div>
				</Match>

				{/* Done */}
				<Match when={step() === "done"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<div class="mb-4 text-center">
							<span class="text-4xl" role="img" aria-label="Success">
								✅
							</span>
						</div>
						<h2 class="mb-2 text-center text-lg font-semibold text-text-primary">
							Key backup is set up
						</h2>
						<p class="mb-6 text-center text-sm text-text-muted">
							<Show
								when={recoveryKey()}
								fallback="Your message keys will be backed up automatically."
							>
								Your message keys will be backed up automatically. Keep your
								recovery key safe — you'll need it to restore your messages.
							</Show>
						</p>
						<div class="flex justify-center">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover"
							>
								Done
							</button>
						</div>
					</div>
				</Match>

				{/* Backup exists but isn't active — restore/unlock */}
				<Match when={step() === "restore-needed"}>
					<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-3 text-lg font-semibold text-text-primary">
							Unlock your key backup
						</h2>
						<p class="mb-4 text-sm text-text-muted">
							A key backup already exists for your account but isn't unlocked on
							this device. Enter your recovery key to connect to it — your
							existing backup won't be replaced.
						</p>
						<Show when={errorMessage()}>
							<p class="mb-4 text-sm text-danger-text-bright" role="alert">
								{errorMessage()}
							</p>
						</Show>
						<div class="flex justify-end gap-2">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
							>
								Later
							</button>
							<button
								type="button"
								onClick={doRestore}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover"
							>
								Unlock backup
							</button>
						</div>
					</div>
				</Match>

				{/* Error */}
				<Match when={step() === "error"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-2 text-lg font-semibold text-text-primary">
							Backup setup failed
						</h2>
						<p class="mb-4 text-sm text-danger-text-bright" role="alert">
							{errorMessage()}
						</p>
						<div class="flex justify-end gap-2">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
							>
								Close
							</button>
							<button
								type="button"
								onClick={doSetup}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover"
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

export { BackupSetupDialog };
