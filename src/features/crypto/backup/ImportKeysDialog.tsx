import {
	type Component,
	createEffect,
	createSignal,
	Match,
	Show,
	Switch,
} from "solid-js";
import { useClient } from "../../../client/client";
import { decryptMegolmKeyFile, isMegolmKeyExportFile } from "./megolmKeyFile";

type ImportStep = "intro" | "working" | "done" | "error";

interface ImportKeysDialogProps {
	onClose: () => void;
}

/**
 * Import megolm session keys from a key export file (Element-compatible
 * encrypted format, or a raw unencrypted JSON export). Restores message
 * history on this device after e.g. a server-side backup loss. See
 * issue #420.
 */
const ImportKeysDialog: Component<ImportKeysDialogProps> = (props) => {
	const { client } = useClient();

	const [step, setStep] = createSignal<ImportStep>("intro");
	const [file, setFile] = createSignal<File | null>(null);
	const [passphrase, setPassphrase] = createSignal("");
	const [errorMessage, setErrorMessage] = createSignal("");
	const [importedCount, setImportedCount] = createSignal(0);

	let overlayEl!: HTMLDivElement;
	let fileInput: HTMLInputElement | undefined;
	// Focus the primary control of the current step: keyboard users land on
	// the file picker on open; the overlay holds focus on the other steps
	// so Escape/backdrop handling keeps working.
	createEffect(() => {
		if (step() === "intro") fileInput?.focus();
		else overlayEl.focus();
	});

	const doImport = async (): Promise<void> => {
		const crypto = client.getCrypto();
		const f = file();
		if (!crypto) {
			setErrorMessage("Encryption is not available.");
			setStep("error");
			return;
		}
		if (!f) return;

		setStep("working");
		setErrorMessage("");

		try {
			const text = await f.text();
			const json = isMegolmKeyExportFile(text)
				? await decryptMegolmKeyFile(text, passphrase())
				: text;

			// Count sessions for the confirmation message before handing the
			// payload to the SDK (which returns no count).
			let count = 0;
			try {
				const parsed: unknown = JSON.parse(json);
				if (Array.isArray(parsed)) count = parsed.length;
			} catch {
				throw new Error("The file doesn't contain valid exported keys.");
			}

			await crypto.importRoomKeysAsJson(json);

			setImportedCount(count);
			setStep("done");
		} catch (e) {
			console.error("Key import failed:", e);
			setErrorMessage(
				e instanceof Error ? e.message : "Import failed. Please try again.",
			);
			setStep("error");
		} finally {
			setPassphrase("");
		}
	};

	const handleSubmit = (e: Event): void => {
		e.preventDefault();
		if (file()) void doImport();
	};

	const isBusy = (): boolean => step() === "working";

	return (
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
			role="dialog"
			aria-modal="true"
			aria-label="Import message keys"
			tabIndex={-1}
			ref={overlayEl}
			onClick={(e) => {
				if (e.target === e.currentTarget && !isBusy()) props.onClose();
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape" && !isBusy()) props.onClose();
			}}
		>
			<Switch>
				<Match when={step() === "intro"}>
					<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-3 text-lg font-semibold text-text-primary">
							Import message keys
						</h2>
						<p class="mb-4 text-sm text-text-muted">
							Restore message history on this device from a key export file
							(from Crust or another client like Element).
						</p>
						<form onSubmit={handleSubmit} class="space-y-3">
							<div>
								<label
									for="import-file"
									class="mb-1 block text-sm text-text-muted"
								>
									Key export file
								</label>
								<input
									id="import-file"
									type="file"
									ref={fileInput}
									accept=".txt,.json,text/plain,application/json"
									onChange={(e) => {
										setFile(e.currentTarget.files?.[0] ?? null);
										setErrorMessage("");
									}}
									class="w-full text-sm text-text-muted file:mr-3 file:rounded file:border-0 file:bg-surface-3 file:px-3 file:py-1.5 file:text-sm file:text-text-primary hover:file:bg-surface-4"
								/>
							</div>
							<div>
								<label
									for="import-passphrase"
									class="mb-1 block text-sm text-text-muted"
								>
									Passphrase (if the file is encrypted)
								</label>
								<input
									id="import-passphrase"
									type="password"
									value={passphrase()}
									onInput={(e) => setPassphrase(e.currentTarget.value)}
									autocomplete="off"
									class="w-full rounded bg-surface-2 px-3 py-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-accent-hover"
								/>
							</div>
							<Show when={errorMessage()}>
								<p class="text-sm text-danger-text-bright" role="alert">
									{errorMessage()}
								</p>
							</Show>
							<div class="flex justify-end gap-2 pt-1">
								<button
									type="button"
									onClick={props.onClose}
									class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
								>
									Cancel
								</button>
								<button
									type="submit"
									disabled={!file()}
									class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover disabled:opacity-50"
								>
									Import
								</button>
							</div>
						</form>
					</div>
				</Match>

				<Match when={step() === "working"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							<p class="text-sm text-text-secondary">Importing keys…</p>
						</div>
					</div>
				</Match>

				<Match when={step() === "done"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-2 text-lg font-semibold text-text-primary">
							Keys imported
						</h2>
						<p class="mb-6 text-sm text-text-muted">
							Imported {importedCount()} message keys. Messages they belong to
							will become readable as they load.
						</p>
						<div class="flex justify-end">
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

				<Match when={step() === "error"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-2 text-lg font-semibold text-text-primary">
							Import failed
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

export { ImportKeysDialog };
