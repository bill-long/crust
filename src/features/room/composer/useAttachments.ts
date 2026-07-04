import { type Accessor, createSignal, type Setter } from "solid-js";
import type { TimelineEvent } from "../timeline/timelineTypes";
import type { PendingAttachment } from "./media/types";
import { createPendingAttachment } from "./media/uploadMedia";

/**
 * Pending-attachment queue for the composer: the files staged for upload by
 * paste, the attach button, and drag-and-drop, plus their per-item mutators.
 * Owns the attachments signal and its lifecycle helpers (including previewUrl
 * revocation on remove/clear). Edits can't carry attachments, so enqueue is a
 * no-op while an edit is active.
 *
 * The raw setter is returned too, for the one caller (the voice-note failure
 * path) that parks a failed upload straight into the tray.
 */
export function useAttachments(
	editingEvent: Accessor<TimelineEvent | null | undefined>,
): {
	attachments: Accessor<PendingAttachment[]>;
	setAttachments: Setter<PendingAttachment[]>;
	enqueueFiles: (files: Iterable<File>) => void;
	onFileInputChange: (e: Event & { currentTarget: HTMLInputElement }) => void;
	updateAttachment: (id: string, patch: Partial<PendingAttachment>) => void;
	removeAttachment: (id: string) => void;
	clearAttachments: () => void;
	onPaste: (e: ClipboardEvent) => void;
} {
	const [attachments, setAttachments] = createSignal<PendingAttachment[]>([]);

	/** Queue raw files for upload. The shared seam for paste / attach / drop. */
	const enqueueFiles = (files: Iterable<File>): void => {
		if (editingEvent()) return;
		const list = Array.from(files);
		if (list.length === 0) return;
		// Encrypted and unencrypted rooms both accept attachments; the send path
		// (uploadAndSend) encrypts when the room is encrypted.
		setAttachments((prev) => [...prev, ...list.map(createPendingAttachment)]);
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
		setAttachments((prev) =>
			prev.map((a) => (a.id === id ? { ...a, ...patch } : a)),
		);
	};

	const removeAttachment = (id: string): void => {
		setAttachments((prev) => {
			const found = prev.find((a) => a.id === id);
			if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
			return prev.filter((a) => a.id !== id);
		});
	};

	const clearAttachments = (): void => {
		setAttachments((prev) => {
			for (const a of prev) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
			return [];
		});
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
