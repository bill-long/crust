import { type Component, createSignal, Show } from "solid-js";
import { formatBytes } from "../../../lib/formatBytes";
import {
	decryptAttachment,
	type EncryptedFileInfo,
} from "../composer/media/attachmentCrypto";
import { sanitizeFilename } from "../composer/media/filename";

/**
 * Timeline render of a received `m.file` attachment: a download chip showing
 * the filename and human-readable size. For plain files the chip is a normal
 * download anchor. For encrypted files clicking downloads the ciphertext,
 * verifies + decrypts it (via {@link decryptAttachment} — the same fail-closed
 * verify path the image/lightbox use), and saves the plaintext blob; a
 * malformed descriptor or a hash/decrypt failure shows an inline error rather
 * than ever exposing the ciphertext.
 *
 * The chip is a fixed-height row so it reserves its layout box immediately and
 * the virtualizer doesn't reflow when (for encrypted files) the decrypt
 * resolves.
 */
export const MediaFile: Component<{
	/** Full (unscaled) http URL — plaintext for plain files, ciphertext for encrypted. */
	httpUrl: string | null;
	/** Validated EncryptedFile descriptor; null for plain files (and for a malformed encrypted descriptor — fail closed). */
	file: EncryptedFileInfo | null;
	mimetype: string | null;
	/** Plaintext mimetype for the decrypted blob; null falls back to the browser default. */
	filename: string;
	size: number | null;
	/** Authoritative: when true, `httpUrl` is ciphertext and must be decrypted, never linked directly. */
	isEncrypted: boolean;
}> = (props) => {
	const [busy, setBusy] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	const sizeLabel = (): string =>
		props.size !== null ? formatBytes(props.size) : "";

	const triggerSave = (blob: Blob): void => {
		const objUrl = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = objUrl;
		// `filename` comes from untrusted event content — strip path separators
		// and control chars before using it as the saved name.
		a.download = sanitizeFilename(props.filename);
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(objUrl), 0);
	};

	// Encrypted download: fetch ciphertext → verify+decrypt → save the
	// plaintext blob. Fail closed (inline error) on a missing descriptor,
	// download failure, hash mismatch, or decrypt error.
	const downloadEncrypted = async (): Promise<void> => {
		if (busy()) return;
		setError(null);
		// `isEncrypted` is authoritative, so a null descriptor means a malformed
		// `content.file` — there is nothing safe to download.
		if (!props.httpUrl || !props.file) {
			setError("This file can't be decrypted.");
			return;
		}
		setBusy(true);
		try {
			const res = await fetch(props.httpUrl, { credentials: "omit" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const ciphertext = await res.arrayBuffer();
			const plaintext = await decryptAttachment(ciphertext, props.file);
			triggerSave(
				new Blob(
					[plaintext],
					props.mimetype ? { type: props.mimetype } : undefined,
				),
			);
		} catch {
			setError("Couldn't download file.");
		} finally {
			setBusy(false);
		}
	};

	const DownloadIcon = () => (
		<svg
			class="h-4 w-4 shrink-0 text-text-muted"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			aria-hidden="true"
		>
			<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
			<polyline points="7 10 12 15 17 10" />
			<line x1="12" y1="15" x2="12" y2="3" />
		</svg>
	);

	const FileMeta = () => (
		<span class="flex min-w-0 flex-col text-left">
			<span class="truncate text-sm text-text-secondary">{props.filename}</span>
			<Show when={sizeLabel()}>
				<span class="text-xs text-text-disabled tabular-nums">
					{sizeLabel()}
				</span>
			</Show>
		</span>
	);

	const chipClass =
		"mt-1 flex h-12 max-w-[min(100%,24rem)] items-center gap-2 rounded bg-surface-2 px-3 text-text-secondary transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover";

	return (
		<Show
			when={props.isEncrypted}
			fallback={
				// Plain file: a direct download anchor. `httpUrl` is the plaintext
				// media URL (same source the inline <img> uses for plain images).
				<a
					href={props.httpUrl ?? "#"}
					download={sanitizeFilename(props.filename)}
					class={chipClass}
					aria-label={`Download ${props.filename}${sizeLabel() ? `, ${sizeLabel()}` : ""}`}
				>
					<DownloadIcon />
					<FileMeta />
				</a>
			}
		>
			<div class="mt-1 flex max-w-[min(100%,24rem)] flex-col gap-1">
				<button
					type="button"
					class={`${chipClass} mt-0 disabled:cursor-progress disabled:opacity-70`}
					onClick={downloadEncrypted}
					disabled={busy()}
					aria-label={`Download ${props.filename}${sizeLabel() ? `, ${sizeLabel()}` : ""}`}
				>
					<DownloadIcon />
					<FileMeta />
					<Show when={busy()}>
						<span class="ml-auto text-xs text-text-disabled" aria-busy="true">
							Decrypting…
						</span>
					</Show>
				</button>
				<Show when={error()}>
					<p class="text-xs text-danger-text" role="alert">
						{error()}
					</p>
				</Show>
			</div>
		</Show>
	);
};
