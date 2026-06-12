import {
	createEffect,
	createMemo,
	createResource,
	createSignal,
	onCleanup,
} from "solid-js";
import { decryptAttachment, type EncryptedFileInfo } from "./attachmentCrypto";

/**
 * Result of a single attachment decryption: either a usable blob URL, an
 * in-progress fetch, or a closed failure (download error, hash mismatch, or
 * decrypt error). We never expose ciphertext as a URL.
 */
export interface DecryptedMedia {
	/** Object URL of the decrypted blob, or null while loading / on failure. */
	url: () => string | null;
	loading: () => boolean;
	/** True when download, hash-verify, or decryption failed (fail closed). */
	failed: () => boolean;
}

type DecryptState = { blob: Blob } | { failed: true };

/**
 * Download a ciphertext URL, verify + decrypt it, and expose a blob object URL
 * for the plaintext, revoking it on change/unmount. Both the inline timeline
 * image and the lightbox pass the *unscaled* ciphertext http URL they already
 * resolved (scaling can't apply to encrypted bytes server-side).
 *
 * Fetches with `credentials: "omit"` to match the rest of the app's media
 * loading. Any failure resolves to `failed` rather than throwing, so a bad or
 * tampered attachment shows an error placeholder instead of crashing the row.
 *
 * @param httpUrl accessor for the ciphertext http URL (null disables fetch)
 * @param file accessor for the validated EncryptedFile descriptor
 * @param mimetype accessor for the plaintext mimetype (sets the blob type)
 */
export function createDecryptedObjectUrl(
	httpUrl: () => string | null | undefined,
	file: () => EncryptedFileInfo | null | undefined,
	mimetype?: () => string | null | undefined,
): DecryptedMedia {
	// Stabilize the resource source so re-projection of an identical event
	// (same url + iv) doesn't retrigger a download/decrypt.
	const source = createMemo<{
		httpUrl: string;
		file: EncryptedFileInfo;
	} | null>((prev) => {
		const url = httpUrl();
		const f = file();
		if (!url || !f) return null;
		if (prev && prev.httpUrl === url && prev.file.iv === f.iv) return prev;
		return { httpUrl: url, file: f };
	}, null);

	const [state] = createResource(source, async (src): Promise<DecryptState> => {
		try {
			const res = await fetch(src.httpUrl, { credentials: "omit" });
			if (!res.ok) return { failed: true };
			const ciphertext = await res.arrayBuffer();
			const plaintext = await decryptAttachment(ciphertext, src.file);
			const type = mimetype?.();
			return {
				blob: new Blob([plaintext], type ? { type } : undefined),
			};
		} catch {
			return { failed: true };
		}
	});

	const [url, setUrl] = createSignal<string | null>(null);
	// Mint a fresh object URL when a decrypted blob arrives; revoke the prior
	// one. onCleanup covers unmount and the final value.
	createEffect(() => {
		const s = state();
		const next = s && "blob" in s ? URL.createObjectURL(s.blob) : null;
		setUrl((prev) => {
			if (prev) URL.revokeObjectURL(prev);
			return next;
		});
	});
	onCleanup(() => {
		const current = url();
		if (current) URL.revokeObjectURL(current);
	});

	return {
		url,
		loading: () => state.loading,
		failed: () => {
			const s = state();
			return !!s && "failed" in s;
		},
	};
}
