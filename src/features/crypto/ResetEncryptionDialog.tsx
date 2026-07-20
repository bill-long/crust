import type { GeneratedSecretStorageKey } from "matrix-js-sdk/lib/crypto-api";
import {
	type Component,
	createEffect,
	createSignal,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { useClient } from "../../client/client";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { ensureKeyBackup, fetchServerKeyBackup } from "./backup/keyBackupSetup";
import { RecoveryKeyDisplay } from "./backup/RecoveryKeyDisplay";
import { UiaDialog } from "./UiaDialog";
import { passwordUiaCallback } from "./uiaPassword";

type ResetStep = "intro" | "uia" | "working" | "show-key" | "done" | "error";

interface ResetEncryptionDialogProps {
	onClose: () => void;
}

/**
 * Last-resort encryption reset for when the account's cross-signing
 * identity exists on the server but NO accessible session holds its
 * private keys — e.g. another client reset encryption and was logged out
 * before the new secrets reached secret storage (issue #420). In that
 * state nothing can be recovered, so the only way forward is to rotate
 * the identity again from here.
 *
 * This is deliberately destructive and the intro copy says so:
 * `crypto.resetEncryption` rotates the cross-signing identity (other
 * sessions become unverified, contacts see an identity change), deletes
 * every server-side key backup, and wipes secret storage. Afterwards we
 * re-establish secret storage with a fresh recovery key (shown to the
 * user) and connect to the new empty backup, so the account ends healthy.
 * Message keys already in this device's crypto store are unaffected, so
 * history stays readable here and is re-uploaded to the new backup.
 */
const ResetEncryptionDialog: Component<ResetEncryptionDialogProps> = (
	props,
) => {
	const { client, cryptoStatus, clearSecretStorageCache } = useClient();

	const [step, setStep] = createSignal<ResetStep>("intro");
	const [recoveryKey, setRecoveryKey] = createSignal<string | undefined>();
	const [errorMessage, setErrorMessage] = createSignal("");
	// Set when the reset succeeded but re-establishing secret storage didn't
	// finish cleanly — the new key is still shown, flagged as incomplete.
	const [partial, setPartial] = createSignal(false);
	let disposed = false;

	onCleanup(() => {
		disposed = true;
	});

	// Focus follows the step: the password step's primary control is its
	// input; every other step keeps focus on the overlay so Escape/backdrop
	// handling works from anywhere.
	let overlayEl!: HTMLDivElement;
	createEffect(() => {
		if (step() === "uia") {
			overlayEl
				.querySelector<HTMLInputElement>("input[type=password]")
				?.focus();
		} else {
			overlayEl.focus();
		}
	});

	const doReset = async (password: string): Promise<void> => {
		const crypto = client.getCrypto();
		if (!crypto) {
			setErrorMessage("Encryption is not available.");
			setStep("error");
			return;
		}
		const userId = client.getUserId();
		if (!userId) {
			setErrorMessage("Unable to determine user ID.");
			setStep("error");
			return;
		}

		setStep("working");
		setErrorMessage("");
		setPartial(false);

		// Declared outside the try so a minted key is still shown if a later
		// step fails (it may already be the account's default).
		let generatedKey: GeneratedSecretStorageKey | undefined;

		try {
			// Rotate the identity, delete all server-side backups, wipe 4S,
			// and create a fresh empty backup (SDK resetEncryption does all of
			// this in one call).
			await crypto.resetEncryption(passwordUiaCallback(userId, password));
			if (disposed) return;

			// Re-establish secret storage under a fresh recovery key and
			// connect to the backup resetEncryption just created.
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

			if (generatedKey?.encodedPrivateKey) {
				setRecoveryKey(generatedKey.encodedPrivateKey);
				// The backup was just created locally, so needs-restore would be
				// unexpected — flag it rather than claim full success.
				setPartial(result.outcome === "needs-restore");
				setStep("show-key");
			} else {
				// No new key minted means secret storage was somehow already set
				// up; the reset itself still succeeded.
				setStep("done");
			}
		} catch (e) {
			if (disposed) return;
			console.error("Encryption reset failed:", e);
			clearSecretStorageCache();
			if (generatedKey?.encodedPrivateKey) {
				setRecoveryKey(generatedKey.encodedPrivateKey);
				setPartial(true);
				setStep("show-key");
			} else {
				setErrorMessage(
					userFacingErrorMessage(e, "Reset failed. Please try again."),
				);
				setStep("error");
			}
		}
	};

	const handleBackdropClick = (e: MouseEvent): void => {
		if (e.target === e.currentTarget && step() !== "working") {
			if (step() === "show-key") return; // Don't dismiss while showing key
			if (step() === "uia") {
				setStep("intro");
				return;
			}
			props.onClose();
		}
	};

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape" && step() !== "working" && step() !== "show-key") {
			if (step() === "uia") {
				setStep("intro");
				return;
			}
			props.onClose();
		}
	};

	return (
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			role="dialog"
			aria-modal="true"
			aria-label="Reset encryption"
			tabIndex={-1}
			ref={overlayEl}
			onClick={handleBackdropClick}
			onKeyDown={handleKeyDown}
		>
			<Switch>
				{/* Intro / warning */}
				<Match when={step() === "intro"}>
					<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-3 text-lg font-semibold text-text-primary">
							Reset encryption
						</h2>
						<p class="mb-2 text-sm text-text-secondary">
							Your account's encryption identity can't be recovered by any of
							your sessions. Resetting creates a brand-new identity from this
							device.
						</p>
						<p class="mb-2 text-sm text-text-muted">
							This cannot be undone: your other sessions will need to be
							re-verified, people you chat with may see a warning that your
							identity changed, and any server-side message-key backup is
							replaced with an empty one.
						</p>
						<p class="mb-6 text-sm text-text-muted">
							Messages stored on this device stay readable. You'll get a new
							recovery key at the end — save it.
						</p>
						<div class="flex justify-end gap-2">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={() => setStep("uia")}
								class="rounded bg-danger px-4 py-2 text-sm font-semibold text-danger-foreground transition-colors hover:bg-danger/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Reset encryption
							</button>
						</div>
					</div>
				</Match>

				{/* Password (UIA) */}
				<Match when={step() === "uia"}>
					<UiaDialog
						onSubmit={(password) => void doReset(password)}
						onCancel={() => setStep("intro")}
					/>
				</Match>

				{/* Working */}
				<Match when={step() === "working"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							<p class="text-sm text-text-secondary">Resetting encryption…</p>
						</div>
					</div>
				</Match>

				{/* Show recovery key */}
				<Match when={step() === "show-key"}>
					<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-3 text-lg font-semibold text-text-primary">
							Save your new recovery key
						</h2>
						<Show when={partial()}>
							<p
								class="mb-4 rounded-lg bg-warning-bg/60 px-3 py-2 text-sm text-warning-text-bright"
								role="alert"
							>
								The reset may not have finished completely. Save this key, then
								reopen this page and check Devices &amp; Security.
							</p>
						</Show>
						<p class="mb-4 text-sm text-text-muted">
							Store this key somewhere safe. Your previous recovery keys no
							longer work.
						</p>

						<Show when={recoveryKey()}>
							{(key) => <RecoveryKeyDisplay recoveryKey={key()} />}
						</Show>

						<div class="flex justify-end">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover"
							>
								I've saved my key
							</button>
						</div>
					</div>
				</Match>

				{/* Done (no new key was needed) */}
				<Match when={step() === "done"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<div class="mb-4 flex justify-center">
							<span class="flex h-12 w-12 items-center justify-center rounded-full bg-success-bg">
								<svg
									class="h-6 w-6 text-success-text"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2.5"
									stroke-linecap="round"
									stroke-linejoin="round"
									role="img"
									aria-label="Success"
								>
									<path d="M20 6L9 17l-5-5" />
								</svg>
							</span>
						</div>
						<h2 class="mb-2 text-center text-lg font-semibold text-text-primary">
							Encryption was reset
						</h2>
						<p class="mb-6 text-center text-sm text-text-muted">
							Your other sessions will need to be verified again from this
							device.
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

				{/* Error */}
				<Match when={step() === "error"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-2 text-lg font-semibold text-text-primary">
							Reset failed
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
								onClick={() => setStep("intro")}
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

export { ResetEncryptionDialog };
