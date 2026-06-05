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
	canConsolidateRecoveryKey,
	getConsolidationReadiness,
	secretStorageResetOpts,
} from "./recoveryKeyReset";

type ResetStep = "intro" | "working" | "show-key" | "error";

interface RecoveryKeyResetDialogProps {
	onClose: () => void;
}

/**
 * Resets the account's recovery key, consolidating secret storage under a
 * single new key. Used to repair "split" secret storage where different
 * secrets are encrypted under different recovery keys.
 *
 * Non-destructive: re-keys secret storage with `setupNewSecretStorage` but
 * preserves cross-signing identity and the key-backup version (the existing
 * secrets are re-encrypted under the new key). Other sessions stay verified.
 * It only proceeds when every secret is available locally, so re-keying can't
 * orphan a secret under a key the user no longer has.
 */
const RecoveryKeyResetDialog: Component<RecoveryKeyResetDialogProps> = (
	props,
) => {
	const { client, cryptoStatus, clearSecretStorageCache } = useClient();

	const [step, setStep] = createSignal<ResetStep>("intro");
	const [recoveryKey, setRecoveryKey] = createSignal<string | undefined>();
	const [errorMessage, setErrorMessage] = createSignal("");
	const [partial, setPartial] = createSignal(false);
	const [copied, setCopied] = createSignal(false);
	let disposed = false;
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;

	onCleanup(() => {
		disposed = true;
		if (copiedTimer !== undefined) clearTimeout(copiedTimer);
	});

	const doReset = async (): Promise<void> => {
		const crypto = client.getCrypto();
		if (!crypto) {
			setErrorMessage("Encryption is not available.");
			setStep("error");
			return;
		}

		setStep("working");
		setErrorMessage("");
		setPartial(false);

		// Declared outside the try so a generated key is still shown if a later
		// step fails (the new key may already be the account's default).
		let generatedKey: GeneratedSecretStorageKey | undefined;

		try {
			// Only re-key when every secret is available locally; otherwise
			// re-keying would orphan a secret under a key the user no longer has.
			const readiness = await getConsolidationReadiness(crypto);
			if (disposed) return;
			if (!canConsolidateRecoveryKey(readiness)) {
				setErrorMessage(
					"Your encryption keys aren't all available on this device yet. Verify this session (and make sure key backup is connected), then try again.",
				);
				setStep("error");
				return;
			}

			await crypto.bootstrapSecretStorage(
				secretStorageResetOpts(async () => {
					const key = await crypto.createRecoveryKeyFromPassphrase();
					generatedKey = key;
					return key;
				}),
			);
			if (disposed) return;

			const status = await crypto.getSecretStorageStatus();
			if (disposed) return;

			await cryptoStatus.refresh();
			if (disposed) return;

			if (generatedKey?.encodedPrivateKey) {
				setRecoveryKey(generatedKey.encodedPrivateKey);
				// If secret storage isn't fully populated under the new key, warn
				// but still show the key — it is now the account default.
				setPartial(!status.ready);
				setStep("show-key");
			} else {
				setErrorMessage("Reset did not produce a new recovery key.");
				setStep("error");
			}
		} catch (e) {
			if (disposed) return;
			console.error("Recovery key reset failed:", e);
			clearSecretStorageCache();
			if (generatedKey?.encodedPrivateKey) {
				// A new key was generated and may already be the account default;
				// show it so the user can save it, flagged as incomplete.
				setRecoveryKey(generatedKey.encodedPrivateKey);
				setPartial(true);
				setStep("show-key");
			} else {
				setErrorMessage(
					e instanceof Error ? e.message : "Reset failed. Please try again.",
				);
				setStep("error");
			}
		}
	};

	const copyRecoveryKey = async (): Promise<void> => {
		const key = recoveryKey();
		if (!key) return;
		try {
			await navigator.clipboard.writeText(key);
			setCopied(true);
			if (copiedTimer !== undefined) clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => {
				copiedTimer = undefined;
				if (!disposed) setCopied(false);
			}, 2000);
		} catch {
			// Clipboard API not available; user can manually select + copy
		}
	};

	const downloadRecoveryKey = (): void => {
		const key = recoveryKey();
		if (!key) return;
		const blob = new Blob([`Recovery Key\n\n${key}\n`], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "crust-recovery-key.txt";
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 0);
	};

	const handleBackdropClick = (e: MouseEvent): void => {
		if (e.target === e.currentTarget && step() !== "working") {
			if (step() === "show-key") return; // Don't dismiss while showing key
			props.onClose();
		}
	};

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape" && step() !== "working" && step() !== "show-key") {
			props.onClose();
		}
	};

	return (
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			role="dialog"
			aria-modal="true"
			aria-label="Reset recovery key"
			tabIndex={-1}
			ref={(el) => el.focus()}
			onClick={handleBackdropClick}
			onKeyDown={handleKeyDown}
		>
			<Switch>
				{/* Intro / confirm */}
				<Match when={step() === "intro"}>
					<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-3 text-lg font-semibold text-text-primary">
							Reset recovery key
						</h2>
						<p class="mb-2 text-sm text-text-secondary">
							This replaces your recovery key with a single new one and stores
							all your encryption secrets under it. Use this if you've ended up
							with more than one recovery key.
						</p>
						<p class="mb-6 text-sm text-text-muted">
							Your other sessions stay verified and your message history is
							kept. Your previous recovery keys will stop working, so save the
							new one.
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
								onClick={doReset}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover"
							>
								Reset recovery key
							</button>
						</div>
					</div>
				</Match>

				{/* Working */}
				<Match when={step() === "working"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							<p class="text-sm text-text-secondary">Resetting recovery key…</p>
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

						<div class="mb-4 rounded-lg bg-surface-2 p-4">
							<code class="block break-all font-mono text-sm leading-relaxed text-success-text">
								{recoveryKey()}
							</code>
						</div>

						<div class="mb-6 flex gap-2">
							<button
								type="button"
								onClick={copyRecoveryKey}
								class="flex-1 rounded bg-surface-3 px-3 py-2 text-sm text-text-primary transition-colors hover:bg-surface-4"
							>
								{copied() ? "Copied \u2713" : "Copy"}
							</button>
							<button
								type="button"
								onClick={downloadRecoveryKey}
								class="flex-1 rounded bg-surface-3 px-3 py-2 text-sm text-text-primary transition-colors hover:bg-surface-4"
							>
								Download
							</button>
						</div>

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

				{/* Error */}
				<Match when={step() === "error"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-2 text-lg font-semibold text-text-primary">
							Reset failed
						</h2>
						<p class="mb-4 text-sm text-danger-text-bright">{errorMessage()}</p>
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

export { RecoveryKeyResetDialog };
