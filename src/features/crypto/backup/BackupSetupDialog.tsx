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
import { secretStorageBootstrapOpts } from "./secretStorageBootstrap";

type SetupStep = "intro" | "working" | "show-key" | "done" | "error";

interface BackupSetupDialogProps {
	onClose: () => void;
}

/**
 * Wizard dialog for setting up key backup + secret storage.
 * Flow: intro → working → show-key → done (or error at any point).
 *
 * Secret storage is reused if it already exists: the SDK only calls
 * createSecretStorageKey (minting a new recovery key) when no storage exists,
 * so the "show recovery key" step is skipped on reuse. See
 * secretStorageBootstrapOpts.
 */
const BackupSetupDialog: Component<BackupSetupDialogProps> = (props) => {
	const { client, cryptoStatus, clearSecretStorageCache } = useClient();

	const [step, setStep] = createSignal<SetupStep>("intro");
	const [recoveryKey, setRecoveryKey] = createSignal<string | undefined>();
	const [errorMessage, setErrorMessage] = createSignal("");
	const [copied, setCopied] = createSignal(false);
	let disposed = false;
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;

	onCleanup(() => {
		disposed = true;
		if (copiedTimer !== undefined) clearTimeout(copiedTimer);
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

			// Reuse existing secret storage; only mint a new recovery key when
			// none exists (createSecretStorageKey is called only then). Never
			// force new secret storage — that would mint a fresh recovery key on
			// every run (see secretStorageBootstrapOpts).
			await crypto.bootstrapSecretStorage(
				secretStorageBootstrapOpts(async () => {
					const key = await crypto.createRecoveryKeyFromPassphrase();
					generatedKey = key;
					return key;
				}),
			);

			if (disposed) return;

			await cryptoStatus.refresh();
			if (disposed) return;

			if (generatedKey?.encodedPrivateKey) {
				setRecoveryKey(generatedKey.encodedPrivateKey);
				setStep("show-key");
			} else {
				// Secret storage already existed; backup created using existing key
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
		const blob = new Blob([`Recovery Key\n\n${key}\n`], {
			type: "text/plain",
		});
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
								{copied() ? "Copied ✓" : "Copy"}
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
								onClick={() => {
									setStep("done");
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

				{/* Error */}
				<Match when={step() === "error"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-2 text-lg font-semibold text-text-primary">
							Backup setup failed
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
