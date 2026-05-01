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

type SetupStep = "intro" | "working" | "show-key" | "done" | "error";

interface BackupSetupDialogProps {
	onClose: () => void;
}

/**
 * Wizard dialog for setting up key backup + secret storage.
 * Flow: intro → working → show-key → done (or error at any point).
 *
 * If secret storage already exists, the SDK reuses it and the
 * createSecretStorageKey callback is never called — in that case
 * we skip the "show recovery key" step.
 */
const BackupSetupDialog: Component<BackupSetupDialogProps> = (props) => {
	const { client, cryptoStatus, clearSecretStorageCache } = useClient();

	const [step, setStep] = createSignal<SetupStep>("intro");
	const [recoveryKey, setRecoveryKey] = createSignal<string | undefined>();
	const [errorMessage, setErrorMessage] = createSignal("");
	const [copied, setCopied] = createSignal(false);
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

			await crypto.bootstrapSecretStorage({
				createSecretStorageKey: async () => {
					const key = await crypto.createRecoveryKeyFromPassphrase();
					generatedKey = key;
					return key;
				},
				setupNewKeyBackup: true,
				setupNewSecretStorage: true,
			});

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
			setTimeout(() => setCopied(false), 2000);
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
		a.click();
		URL.revokeObjectURL(url);
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
					<div class="w-full max-w-md rounded-lg bg-neutral-900 p-6 shadow-xl">
						<h2 class="mb-3 text-lg font-semibold text-white">
							Set up key backup
						</h2>
						<p class="mb-2 text-sm text-neutral-300">
							Key backup stores your encrypted message keys on the server so you
							can access your message history from any device.
						</p>
						<p class="mb-6 text-sm text-neutral-400">
							You'll receive a recovery key — save it somewhere safe. You'll
							need it if you lose access to all your devices.
						</p>
						<div class="flex justify-end gap-2">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded px-3 py-2 text-sm text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
							>
								Later
							</button>
							<button
								type="button"
								onClick={doSetup}
								class="rounded bg-pink-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-pink-500"
							>
								Continue
							</button>
						</div>
					</div>
				</Match>

				{/* Working */}
				<Match when={step() === "working"}>
					<div class="w-full max-w-sm rounded-lg bg-neutral-900 p-6 shadow-xl">
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-pink-500" />
							<p class="text-sm text-neutral-300">Setting up key backup…</p>
						</div>
					</div>
				</Match>

				{/* Show recovery key */}
				<Match when={step() === "show-key"}>
					<div class="w-full max-w-md rounded-lg bg-neutral-900 p-6 shadow-xl">
						<h2 class="mb-3 text-lg font-semibold text-white">
							Save your recovery key
						</h2>
						<p class="mb-4 text-sm text-neutral-400">
							Store this key somewhere safe. You'll need it to recover your
							encrypted messages if you lose access to all your devices.
						</p>

						<div class="mb-4 rounded-lg bg-neutral-800 p-4">
							<code class="block break-all font-mono text-sm leading-relaxed text-green-400">
								{recoveryKey()}
							</code>
						</div>

						<div class="mb-6 flex gap-2">
							<button
								type="button"
								onClick={copyRecoveryKey}
								class="flex-1 rounded bg-neutral-700 px-3 py-2 text-sm text-white transition-colors hover:bg-neutral-600"
							>
								{copied() ? "Copied ✓" : "Copy"}
							</button>
							<button
								type="button"
								onClick={downloadRecoveryKey}
								class="flex-1 rounded bg-neutral-700 px-3 py-2 text-sm text-white transition-colors hover:bg-neutral-600"
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
								class="rounded bg-pink-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-pink-500"
							>
								I've saved my key
							</button>
						</div>
					</div>
				</Match>

				{/* Done */}
				<Match when={step() === "done"}>
					<div class="w-full max-w-sm rounded-lg bg-neutral-900 p-6 shadow-xl">
						<div class="mb-4 text-center">
							<span class="text-4xl" role="img" aria-label="Success">
								✅
							</span>
						</div>
						<h2 class="mb-2 text-center text-lg font-semibold text-white">
							Key backup is set up
						</h2>
						<p class="mb-6 text-center text-sm text-neutral-400">
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
								class="rounded bg-pink-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-pink-500"
							>
								Done
							</button>
						</div>
					</div>
				</Match>

				{/* Error */}
				<Match when={step() === "error"}>
					<div class="w-full max-w-sm rounded-lg bg-neutral-900 p-6 shadow-xl">
						<h2 class="mb-2 text-lg font-semibold text-white">
							Backup setup failed
						</h2>
						<p class="mb-4 text-sm text-red-300">{errorMessage()}</p>
						<div class="flex justify-end gap-2">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded px-3 py-2 text-sm text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
							>
								Close
							</button>
							<button
								type="button"
								onClick={doSetup}
								class="rounded bg-pink-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-pink-500"
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

export default BackupSetupDialog;
