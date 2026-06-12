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
	/**
	 * The decrypted Blob itself, or null while loading / on failure. Lets a
	 * consumer mint its own object URL with an independent lifetime (e.g. an
	 * "open in new tab" that must outlive this hook's managed URL).
	 */
	blob: () => Blob | null;
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
		mimetype: string | null;
	} | null>((prev) => {
		const url = httpUrl();
		const f = file();
		if (!url || !f) return null;
		const mt = mimetype?.() ?? null;
		// Compare every field that affects the download + decrypt + verify + blob
		// type, so a re-projection that changes key material, the expected hash,
		// or the mimetype can never reuse a stale descriptor (which would bypass
		// the hash check or keep the wrong Blob type).
		if (
			prev &&
			prev.httpUrl === url &&
			prev.file.iv === f.iv &&
			prev.file.key.k === f.key.k &&
			prev.file.hashes.sha256 === f.hashes.sha256 &&
			prev.mimetype === mt
		) {
			return prev;
		}
		return { httpUrl: url, file: f, mimetype: mt };
	}, null);

	const [state] = createResource(source, async (src): Promise<DecryptState> => {
		try {
			const res = await fetch(src.httpUrl, { credentials: "omit" });
			if (!res.ok) return { failed: true };
			const ciphertext = await res.arrayBuffer();
			const plaintext = await decryptAttachment(ciphertext, src.file);
			return {
				blob: new Blob(
					[plaintext],
					src.mimetype ? { type: src.mimetype } : undefined,
				),
			};
		} catch {
			return { failed: true };
		}
	});

	// `createResource` keeps the previous resolved value while a new source is
	// loading. Expose only the value for the *current, settled* source: null
	// while loading or when there's no source. Otherwise switching between
	// encrypted images would briefly leak the previous image's blob via
	// url()/blob()/failed() instead of showing a decrypting placeholder.
	const current = (): DecryptState | null => {
		if (!source() || state.loading) return null;
		return state() ?? null;
	};

	const [url, setUrl] = createSignal<string | null>(null);
	// Mint a fresh object URL when a decrypted blob arrives; revoke the prior
	// one (also clears it while a new decrypt is loading). onCleanup covers
	// unmount and the final value.
	createEffect(() => {
		const s = current();
		const next = s && "blob" in s ? URL.createObjectURL(s.blob) : null;
		setUrl((prev) => {
			if (prev) URL.revokeObjectURL(prev);
			return next;
		});
	});
	onCleanup(() => {
		const value = url();
		if (value) URL.revokeObjectURL(value);
	});

	return {
		url,
		blob: () => {
			const s = current();
			return s && "blob" in s ? s.blob : null;
		},
		loading: () => state.loading,
		failed: () => {
			const s = current();
			return !!s && "failed" in s;
		},
	};
}
