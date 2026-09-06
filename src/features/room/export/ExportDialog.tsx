import type { MatrixClient } from "matrix-js-sdk";
import {
	type Component,
	createSignal,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { Modal } from "../../../components/Modal";
import { userFacingErrorMessage } from "../../../lib/errorMessage";
import { saveBlobToDisk } from "../../../lib/saveBlob";
import { type ExportFormat, exportRoom } from "./exportRoom";

interface ExportDialogProps {
	client: MatrixClient;
	roomId: string;
	onClose: () => void;
}

const radioClass =
	"flex items-center gap-2 text-sm text-text-secondary cursor-pointer";
const inputRadioClass =
	"accent-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover";

/**
 * Per-room history export (#530): HTML / plain text / JSON, optionally
 * bundling decrypted attachments into a zip. The output is assembled in
 * memory and written as one file at the end, so cancelling never leaves
 * a partial file of decrypted history behind.
 */
const ExportDialog: Component<ExportDialogProps> = (props) => {
	const room = () => props.client.getRoom(props.roomId);
	const encrypted = () => room()?.hasEncryptionStateEvent() ?? false;

	const [format, setFormat] = createSignal<ExportFormat>("html");
	const [wholeHistory, setWholeHistory] = createSignal(false);
	const [limitText, setLimitText] = createSignal("100");
	const [includeAttachments, setIncludeAttachments] = createSignal(false);
	const [running, setRunning] = createSignal(false);
	const [progressText, setProgressText] = createSignal("");
	const [error, setError] = createSignal("");

	let cancelled = false;
	let aborter: AbortController | null = null;
	onCleanup(() => {
		cancelled = true;
		aborter?.abort();
	});

	let overlayEl!: HTMLDivElement;

	const parsedLimit = (): number | null => {
		if (wholeHistory()) return null;
		// Number(), not parseInt: "1e10" must not silently export a
		// different count (parseInt would read it as 1).
		const n = Number(limitText());
		return Number.isInteger(n) && n > 0 ? n : null;
	};

	const startDisabled = (): boolean =>
		running() || (!wholeHistory() && parsedLimit() === null);

	const start = async (): Promise<void> => {
		const target = room();
		if (!target || startDisabled()) return;
		cancelled = false;
		aborter = new AbortController();
		setError("");
		setRunning(true);
		try {
			const result = await exportRoom(
				props.client,
				target,
				{
					format: format(),
					limit: parsedLimit(),
					includeAttachments: includeAttachments(),
				},
				(p) => {
					setProgressText(
						p.phase === "history"
							? `Fetching history… ${p.events} messages`
							: p.phase === "attachments"
								? `Exporting attachments… ${p.attachmentsDone}/${p.attachmentsTotal}`
								: "Assembling export…",
					);
				},
				() => cancelled,
				aborter.signal,
			);
			if (result) {
				saveBlobToDisk(result.blob, result.filename);
				props.onClose();
				return;
			}
			// Cancelled: back to the options, nothing was written.
		} catch (e) {
			console.error("Chat export failed:", e);
			setError(userFacingErrorMessage(e, "Export failed. Try again."));
		} finally {
			setRunning(false);
			setProgressText("");
		}
	};

	const dismiss = (): void => {
		if (running()) {
			if (!cancelled) {
				// Graceful cancel: the engine stops at its next check and any
				// in-flight attachment download is aborted.
				cancelled = true;
				aborter?.abort();
				return;
			}
			// A second dismissal while a cancel is still pending is the
			// escape hatch from a request the client can't interrupt (e.g. a
			// hung pagination call) - close outright; the abandoned run's
			// next cancellation check discards its work.
			props.onClose();
			return;
		}
		props.onClose();
	};

	return (
		<Modal
			open
			onClose={dismiss}
			label="Export chat"
			initialFocus={() => overlayEl}
			contentRef={(element) => {
				overlayEl = element;
			}}
		>
			<div class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
				<h2 class="mb-2 text-lg font-semibold text-text-primary">
					Export chat
				</h2>
				<p class="mb-3 text-sm text-text-muted">
					Save this room's history to a file on this device.
				</p>
				<Show when={encrypted()}>
					<p
						class="mb-3 rounded-lg bg-warning-bg/60 px-3 py-2 text-sm text-warning-text-bright"
						role="note"
					>
						This room is end-to-end encrypted. The export (and any bundled
						attachments) is written as readable plaintext - store it as
						carefully as the messages themselves.
					</p>
				</Show>

				<Switch>
					<Match when={running()}>
						<div class="flex flex-col items-center gap-3 py-4">
							<div class="h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover motion-reduce:animate-none" />
							<p aria-live="polite" class="text-sm text-text-secondary">
								{progressText() || "Preparing…"}
							</p>
							<button
								type="button"
								onClick={dismiss}
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Cancel export
							</button>
						</div>
					</Match>

					<Match when={true}>
						<fieldset class="mb-3">
							<legend class="mb-1 text-xs font-medium text-text-muted uppercase">
								Format
							</legend>
							<div class="flex gap-4">
								<label class={radioClass}>
									<input
										type="radio"
										name="export-format"
										checked={format() === "html"}
										onChange={() => setFormat("html")}
										class={inputRadioClass}
									/>
									HTML
								</label>
								<label class={radioClass}>
									<input
										type="radio"
										name="export-format"
										checked={format() === "text"}
										onChange={() => setFormat("text")}
										class={inputRadioClass}
									/>
									Plain text
								</label>
								<label class={radioClass}>
									<input
										type="radio"
										name="export-format"
										checked={format() === "json"}
										onChange={() => setFormat("json")}
										class={inputRadioClass}
									/>
									JSON
								</label>
							</div>
						</fieldset>

						<fieldset class="mb-3">
							<legend class="mb-1 text-xs font-medium text-text-muted uppercase">
								Range
							</legend>
							<div class="space-y-1">
								<label class={radioClass}>
									<input
										type="radio"
										name="export-range"
										checked={!wholeHistory()}
										onChange={() => setWholeHistory(false)}
										class={inputRadioClass}
									/>
									Last
									<input
										type="number"
										min="1"
										value={limitText()}
										onInput={(e) => {
											setLimitText(e.currentTarget.value);
											// Typing a count IS choosing the last-N range - never
											// let "Entire history" stay armed underneath it.
											setWholeHistory(false);
										}}
										onClick={() => setWholeHistory(false)}
										aria-label="Number of messages"
										class="w-20 rounded bg-surface-2 px-2 py-1 text-sm text-text-primary focus:outline-hidden focus:ring-2 focus:ring-accent-hover"
									/>
									messages
								</label>
								<label class={radioClass}>
									<input
										type="radio"
										name="export-range"
										checked={wholeHistory()}
										onChange={() => setWholeHistory(true)}
										class={inputRadioClass}
									/>
									Entire history
								</label>
							</div>
						</fieldset>

						<label class="mb-1 flex items-start gap-2 py-1 text-sm text-text-secondary">
							<input
								type="checkbox"
								checked={includeAttachments()}
								onChange={(e) => setIncludeAttachments(e.currentTarget.checked)}
								class="mt-0.5 accent-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							/>
							<span>
								Include attachments
								<span class="block text-xs text-text-muted">
									Downloads every file into a zip alongside the export.
								</span>
							</span>
						</label>

						<Show when={error()}>
							<p
								id="export-error"
								role="alert"
								class="mt-2 text-sm text-danger-text-bright"
							>
								{error()}
							</p>
						</Show>

						<div class="mt-4 flex justify-end gap-2">
							<button
								type="button"
								onClick={props.onClose}
								class="rounded px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={() => void start()}
								disabled={startDisabled()}
								aria-describedby={error() ? "export-error" : undefined}
								class="rounded bg-accent px-4 py-2 text-sm font-semibold text-text-primary transition-colors hover:bg-accent-hover disabled:opacity-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Export
							</button>
						</div>
					</Match>
				</Switch>
			</div>
		</Modal>
	);
};

export { ExportDialog };
