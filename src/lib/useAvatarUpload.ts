import type { MatrixClient } from "matrix-js-sdk";
import {
	type Accessor,
	createEffect,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import { userFacingErrorMessage } from "./errorMessage";

const MAX_AVATAR_BYTES = 10 * 1024 * 1024;

interface AvatarUploadOptions {
	/** Changing the dialog opening or room invalidates outstanding work. */
	scope?: Accessor<unknown>;
	/** Persistence and optimistic rendering belong to the caller. */
	onUploaded?: (mxc: string, isCurrent: () => boolean) => Promise<void>;
}

/** Shared image validation, upload cache and lifetime for avatar pickers. */
export function useAvatarUpload(
	client: Pick<MatrixClient, "uploadContent">,
	options: AvatarUploadOptions = {},
) {
	const [mxc, setMxc] = createSignal<string | null>(null);
	const [uploading, setUploading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	let generation = 0;
	let disposed = false;
	let lastFile: File | null = null;
	let uploadedMxc: string | null = null;

	function remove(): void {
		generation++;
		lastFile = null;
		uploadedMxc = null;
		setMxc(null);
		setUploading(false);
		setError(null);
	}

	onCleanup(() => {
		disposed = true;
		generation++;
	});
	if (options.scope) createEffect(on(options.scope, remove, { defer: true }));

	async function pickFile(file: File): Promise<void> {
		// Invalid selections supersede earlier uploads too.
		const gen = ++generation;
		const scope = options.scope?.();
		const isCurrent = () =>
			!disposed && gen === generation && scope === options.scope?.();
		setError(null);
		if (!file.type.startsWith("image/") || file.size > MAX_AVATAR_BYTES) {
			setError(
				!file.type.startsWith("image/")
					? "File must be an image"
					: "Image must be under 10 MB",
			);
			setUploading(false);
			return;
		}
		// A rejected replacement cancels stale work, but Retry still belongs
		// to the last valid selection and can reuse its completed upload.
		if (file !== lastFile) uploadedMxc = null;
		lastFile = file;
		setUploading(true);
		let failureMessage = "Failed to upload avatar";
		try {
			const url = uploadedMxc ?? (await client.uploadContent(file)).content_uri;
			if (!isCurrent()) return;
			uploadedMxc = url;
			setMxc(url);
			failureMessage = "Failed to save avatar";
			await options.onUploaded?.(url, isCurrent);
		} catch (e) {
			if (isCurrent()) setError(userFacingErrorMessage(e, failureMessage));
		} finally {
			if (isCurrent()) setUploading(false);
		}
	}

	return {
		mxc,
		uploading,
		error,
		pickFile,
		remove,
		retry: () => (lastFile ? pickFile(lastFile) : Promise.resolve()),
		clearError: () => setError(null),
	};
}
