import type { GeneratedSecretStorageKey } from "matrix-js-sdk/lib/crypto-api";
import { type Component, createSignal, Match, Show, Switch } from "solid-js";
import { useClient } from "../../client/client";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { trapTabKey } from "../../lib/focusTrap";
import { ensureKeyBackup, fetchServerKeyBackup } from "./backup/keyBackupSetup";
import { RecoveryKeyDisplay } from "./backup/RecoveryKeyDisplay";
import { createUiaOverlayFocus, UiaPrompts } from "./UiaDialog";
import { createUiaDialogFlow } from "./uiaDialogFlow";

type ResetStep = "intro" | "working" | "show-key" | "done" | "error";

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

	// Interactive UIA: the server decides whether the user re-enters a
	// password or approves at the account-management page (#467). The
	// preflight collects AND verifies that BEFORE crypto.resetEncryption
	// runs, because the reset destroys server-side backups and secret
	// storage ahead of its UIA-gated key upload - a cancel or typo at the
	// first prompt must leave the account untouched. The dialog lifecycle
	// around it - unmount tracking, which half is in flight, the
	// dismissal policy - lives in createUiaDialogFlow (#545).
	const uia = createUiaDialogFlow(client);

	// Focus contract: identity prompts focus their own primary control;
	// the overlay reclaims focus lost to promptless view swaps (see
	// createUiaOverlayFocus).
	let overlayEl!: HTMLDivElement;
	createUiaOverlayFocus({ flow: uia.flow, overlay: () => overlayEl, step });

	const doReset = async (): Promise<void> => {
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

		setStep("working");
		setErrorMessage("");
		setPartial(false);

		// Learn, collect, and verify the identity confirmation before
		// anything destructive: cancelling here steps back with the account
		// intact.
		const preflight = await uia.preflight();
		// Unmounted or dismissed while the probe was in flight: don't touch
		// the UI, and don't let the destructive reset run headless with
		// nobody to show the new key to. Nothing between here and `run`
		// awaits, so this one check covers both.
		if (uia.disposed()) return;
		if (preflight.status === "cancelled") {
			setStep("intro");
			return;
		}
		if (preflight.status === "failed") {
			// Logged like the operation's own failures: the two dialogs had
			// drifted on this, and a probe that fails for a reason the
			// curated copy hides is exactly what a console needs (#545).
			console.error("Encryption reset preflight failed:", preflight.error);
			setErrorMessage(
				userFacingErrorMessage(
					preflight.error,
					"Reset failed. Please try again.",
				),
			);
			setStep("error");
			return;
		}
		// Both of these are read after the operation settles, so they live
		// outside it: a minted key is still shown if a later step fails (it
		// may already be the account's default), and the backup outcome
		// decides the warning on the success path.
		let generatedKey: GeneratedSecretStorageKey | undefined;
		let needsRestore = false;
		// True only while the account has no secret storage: the reset wiped
		// it and its replacement has not been minted yet. Any key cached in
		// that window is for storage that no longer exists. Tracked rather
		// than derived from the outcome, because an unmount inside the window
		// returns early and settles the operation as `ok` (#562).
		let secretStorageGone = false;

		const done = await uia.run(async () => {
			// Rotate the identity, delete all server-side backups, wipe 4S,
			// and create a fresh empty backup (SDK resetEncryption does all of
			// this in one call).
			await crypto.resetEncryption(uia.flow.uiaCallback);
			secretStorageGone = true;
			if (uia.disposed()) return;

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
			// The SDK caches the new key as it writes it (cacheSecretStorageKey
			// from bootstrapSecretStorage), so the cache is current again from
			// here and a later unmount must NOT drop it.
			secretStorageGone = false;
			if (uia.disposed()) return;
			needsRestore = result.outcome === "needs-restore";

			await cryptoStatus.refresh();
		});
		if (done.status !== "ok" || secretStorageGone) {
			// The cached 4S key is stale after any mid-reset failure, and
			// after an unmount that stopped the run between the teardown and
			// its replacement - drop it even when the dialog is already gone.
			clearSecretStorageCache();
		}
		if (uia.disposed()) return;

		if (done.status === "ok") {
			if (generatedKey?.encodedPrivateKey) {
				setRecoveryKey(generatedKey.encodedPrivateKey);
				// The backup was just created locally, so needs-restore would be
				// unexpected — flag it rather than claim full success.
				setPartial(needsRestore);
				setStep("show-key");
			} else {
				// No new key minted means secret storage was somehow already set
				// up; the reset itself still succeeded.
				setStep("done");
			}
			return;
		}
		if (done.status === "cancelled") {
			// A cancel here is the mid-operation approval loop (the OP
			// ticket was never granted or expired), and the reset already
			// tore down backups and secret storage - surface it as an
			// interrupted reset, never as a silent step back.
			setErrorMessage(
				"The reset was interrupted before the server confirmed your identity. Run it again to finish setting up a new identity.",
			);
			setStep("error");
			return;
		}
		console.error("Encryption reset failed:", done.error);
		if (generatedKey?.encodedPrivateKey) {
			setRecoveryKey(generatedKey.encodedPrivateKey);
			setPartial(true);
			setStep("show-key");
		} else {
			setErrorMessage(
				userFacingErrorMessage(done.error, "Reset failed. Please try again."),
			);
			setStep("error");
		}
	};

	// The shared policy (see UiaDialogFlow.dismiss), plus the one state
	// only this dialog has: the recovery key is shown exactly once, so
	// nothing dismisses past it. Checked first because show-key cannot
	// coexist with a pending prompt or an in-flight half.
	const dismiss = (): void => {
		if (step() === "show-key") return;
		uia.dismiss(props.onClose);
	};

	const handleBackdropClick = (e: MouseEvent): void => {
		if (e.target !== e.currentTarget) return;
		dismiss();
	};

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Tab") {
			trapTabKey(overlayEl, e);
			return;
		}
		if (e.key !== "Escape") return;
		dismiss();
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
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={() => void doReset()}
								class="rounded bg-danger px-4 py-2 text-sm font-semibold text-danger-foreground transition-colors hover:bg-danger/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Reset encryption
							</button>
						</div>
					</div>
				</Match>

				{/* Identity prompts: rendered while step() is "working" (the
				    flow suspends in preflight or mid-reset), so they shadow
				    the spinner. */}
				<Match when={uia.flow.prompt()}>
					<UiaPrompts flow={uia.flow} />
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
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
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
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
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
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Close
							</button>
							<button
								type="button"
								onClick={() => setStep("intro")}
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

export { ResetEncryptionDialog };
