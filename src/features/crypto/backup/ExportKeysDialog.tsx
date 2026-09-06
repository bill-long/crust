import {
	type Component,
	createEffect,
	createSignal,
	Match,
	on,
	Show,
	Switch,
} from "solid-js";
import { useClient } from "../../../client/client";
import { Modal } from "../../../components/Modal";
import { userFacingErrorMessage } from "../../../lib/errorMessage";
import { saveBlobToDisk } from "../../../lib/saveBlob";
import { encryptMegolmKeyFile } from "./megolmKeyFile";

type ExportStep = "intro" | "working" | "done" | "error";

interface ExportKeysDialogProps {
	onClose: () => void;
}

/**
 * Export this device's megolm session keys to a passphrase-encrypted file
 * (Element-compatible format). Disaster-recovery tool: if the server-side
 * backup is ever lost (e.g. another client resets encryption), history
 * stays restorable from this file. See issue #420.
 */
const ExportKeysDialog: Component<ExportKeysDialogProps> = (props) => {
	const { client } = useClient();

	const [step, setStep] = createSignal<ExportStep>("intro");
	const [passphrase, setPassphrase] = createSignal("");
	const [confirm, setConfirm] = createSignal("");
	const [errorMessage, setErrorMessage] = createSignal("");
	const [fileName, setFileName] = createSignal("");

	let overlayEl!: HTMLDivElement;
	let passphraseInput: HTMLInputElement | undefined;
	// Focus the primary control of the current step: keyboard users land on
	// the passphrase field on open; the overlay holds focus on the other
	// steps so Escape/backdrop handling keeps working.
	createEffect(
		on(
			step,
			() => {
				if (step() === "intro") passphraseInput?.focus();
				else overlayEl.focus();
			},
			{ defer: true },
		),
	);

	const doExport = async (): Promise<void> => {
		const crypto = client.getCrypto();
		if (!crypto) {
			setErrorMessage("Encryption is not available.");
			setStep("error");
			return;
		}
		if (passphrase() !== confirm()) {
			setErrorMessage("Passphrases don't match.");
			return;
		}

		setStep("working");
		setErrorMessage("");

		try {
			const json = await crypto.exportRoomKeysAsJson();
			const encrypted = await encryptMegolmKeyFile(json, passphrase());

			const stamp = new Date().toISOString().slice(0, 10);
			const name = `crust-message-keys-${stamp}.txt`;
			saveBlobToDisk(new Blob([encrypted], { type: "text/plain" }), name);

			setFileName(name);
			setStep("done");
		} catch (e) {
			console.error("Key export failed:", e);
			setErrorMessage(
				userFacingErrorMessage(e, "Export failed. Please try again."),
			);
			setStep("error");
		} finally {
			// Best-effort scrub of the passphrase from component state.
			setPassphrase("");
			setConfirm("");
		}
	};

	const handleSubmit = (e: Event): void => {
		e.preventDefault();
		if (passphrase().length > 0) void doExport();
	};

	const isBusy = (): boolean => step() === "working";

	return (
		<Modal
			open
			portaled
			onClose={props.onClose}
			dismissible={!isBusy()}
			label="Export message keys"
			initialFocus={() => passphraseInput}
			contentRef={(element) => {
				overlayEl = element;
			}}
		>
			<Switch>
				<Match when={step() === "intro"}>
					<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-3 text-lg font-semibold text-text-primary">
							Export message keys
						</h2>
						<p class="mb-4 text-sm text-text-muted">
							Download an offline copy of this device's message keys, protected
							with a passphrase. You can re-import it here or in another client
							(e.g. Element) if your server-side backup is ever lost.
						</p>
						<form onSubmit={handleSubmit} class="space-y-3">
							<div>
								<label
									for="export-passphrase"
									class="mb-1 block text-sm text-text-muted"
								>
									Passphrase
								</label>
								<input
									id="export-passphrase"
									type="password"
									ref={passphraseInput}
									value={passphrase()}
									onInput={(e) => setPassphrase(e.currentTarget.value)}
									autocomplete="new-password"
									required
									class="w-full rounded bg-surface-2 px-3 py-2 text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent-hover"
								/>
							</div>
							<div>
								<label
									for="export-passphrase-confirm"
									class="mb-1 block text-sm text-text-muted"
								>
									Confirm passphrase
								</label>
								<input
									id="export-passphrase-confirm"
									type="password"
									value={confirm()}
									onInput={(e) => setConfirm(e.currentTarget.value)}
									autocomplete="new-password"
									required
									class="w-full rounded bg-surface-2 px-3 py-2 text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent-hover"
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
									disabled={passphrase().length === 0}
									class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover disabled:opacity-50"
								>
									Export
								</button>
							</div>
						</form>
					</div>
				</Match>

				<Match when={step() === "working"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<div class="flex flex-col items-center gap-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							<p class="text-sm text-text-secondary">Exporting keys…</p>
						</div>
					</div>
				</Match>

				<Match when={step() === "done"}>
					<div class="w-full max-w-sm rounded-lg bg-surface-1 p-6 shadow-xl">
						<h2 class="mb-2 text-lg font-semibold text-text-primary">
							Keys exported
						</h2>
						<p class="mb-6 text-sm text-text-muted">
							Saved as {fileName()}. Store it somewhere safe — anyone with the
							file and its passphrase can read your message history.
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
							Export failed
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
		</Modal>
	);
};

export { ExportKeysDialog };
