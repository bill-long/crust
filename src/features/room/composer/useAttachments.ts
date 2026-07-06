import type { Accessor } from "solid-js";
import { createStore, produce, type SetStoreFunction } from "solid-js/store";
import type { TimelineEvent } from "../timeline/timelineTypes";
import type { PendingAttachment } from "./media/types";
import { createPendingAttachment } from "./media/uploadMedia";

/**
 * Pending-attachment queue for the composer: the files staged for upload by
 * paste, the attach button, and drag-and-drop, plus their per-item mutators.
 * Owns the attachments store and its lifecycle helpers (including previewUrl
 * revocation on remove/clear). Edits can't carry attachments, so enqueue is a
 * no-op while an edit is active.
 *
 * The raw setter is returned too, for the one caller (the voice-note failure
 * path) that parks a failed upload straight into the tray.
 */
export function useAttachments(
	editingEvent: Accessor<TimelineEvent | null | undefined>,
): {
	attachments: PendingAttachment[];
	setAttachments: SetStoreFunction<PendingAttachment[]>;
	enqueueFiles: (files: Iterable<File>) => void;
	onFileInputChange: (e: Event & { currentTarget: HTMLInputElement }) => void;
	updateAttachment: (id: string, patch: Partial<PendingAttachment>) => void;
	removeAttachment: (id: string) => void;
	clearAttachments: () => void;
	onPaste: (e: ClipboardEvent) => void;
} {
	// A store (not a signal of an array): updateAttachment mutates a row's field
	// in place, so the row's object reference is stable across edits. That lets
	// the tray's reference-keyed <For> keep each row's DOM node - and the caption
	// input's focus - alive while typing, and avoids remounting every row on each
	// upload-progress tick.
	const [attachments, setAttachments] = createStore<PendingAttachment[]>([]);

	/** Queue raw files for upload. The shared seam for paste / attach / drop. */
	const enqueueFiles = (files: Iterable<File>): void => {
		if (editingEvent()) return;
		const list = Array.from(files);
		if (list.length === 0) return;
		// Encrypted and unencrypted rooms both accept attachments; the send path
		// (uploadAndSend) encrypts when the room is encrypted.
		const created = list.map(createPendingAttachment);
		setAttachments(produce((arr) => arr.push(...created)));
	};

	/** Queue files chosen via the attach button's hidden file input. */
	const onFileInputChange = (
		e: Event & { currentTarget: HTMLInputElement },
	): void => {
		const input = e.currentTarget;
		if (input.files) enqueueFiles(input.files);
		// Reset so picking the same file again still fires `change`.
		input.value = "";
	};

	const updateAttachment = (
		id: string,
		patch: Partial<PendingAttachment>,
	): void => {
		// Merge into the matching row in place; the object reference is preserved,
		// so only the changed field's subscribers re-run (no row remount).
		setAttachments((a) => a.id === id, patch);
	};

	const removeAttachment = (id: string): void => {
		const found = attachments.find((a) => a.id === id);
		if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
		// Surviving rows keep their proxy identity, so <For> moves their nodes
		// rather than recreating them.
		setAttachments((prev) => prev.filter((a) => a.id !== id));
	};

	const clearAttachments = (): void => {
		for (const a of attachments) {
			if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
		}
		setAttachments([]);
	};

	/** Pull any image blobs out of a paste and queue them. */
	const onPaste = (e: ClipboardEvent): void => {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		let hasText = false;
		// DataTransferItemList is index-accessed, not reliably iterable.
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.kind === "string") hasText = true;
			if (item.kind === "file" && item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) files.push(file);
			}
		}
		if (files.length === 0) return;
		// Only suppress the textarea's default when the clipboard is image-only;
		// if text was pasted alongside the image, let the native paste insert it.
		if (!hasText) e.preventDefault();
		enqueueFiles(files);
	};

	return {
		attachments,
		setAttachments,
		enqueueFiles,
		onFileInputChange,
		updateAttachment,
		removeAttachment,
		clearAttachments,
		onPaste,
	};
}
