import { createEffect, createMemo, createSignal } from "solid-js";
import type { LightboxImage } from "./ImageLightbox";
import type { TimelineEvent } from "./timelineTypes";

/**
 * Image-lightbox state for the timeline.
 *
 * The gallery is built from confirmed (status === null) m.image events only.
 * Pending / failed local echoes are excluded because their event id can re-key
 * on confirmation, which would orphan the open lightbox descriptor.
 *
 * Exposes open/close, the current image descriptor, and prev/next navigation.
 * Auto-closes when the open image disappears from the list (redacted, paged
 * out, room switched, status flipped, etc.). The auto-close effect registers
 * under the caller's reactive owner.
 */
export function useImageLightbox(events: TimelineEvent[]) {
	const [lightboxEventId, setLightboxEventId] = createSignal<string | null>(
		null,
	);
	const imageGallery = createMemo<TimelineEvent[]>(() =>
		events.filter(
			(e) => e.msgtype === "m.image" && e.status === null && !!e.mediaFullUrl,
		),
	);
	const lightboxIndex = createMemo<number>(() => {
		const id = lightboxEventId();
		if (!id) return -1;
		return imageGallery().findIndex((e) => e.eventId === id);
	});
	const isOpen = (): boolean => lightboxEventId() !== null;
	// Auto-close if the currently open image disappears from the list
	// (redacted, paged out, room switched, status flipped, etc.).
	createEffect(() => {
		if (lightboxEventId() !== null && lightboxIndex() === -1) {
			setLightboxEventId(null);
		}
	});
	const currentImage = createMemo<LightboxImage | null>(() => {
		const idx = lightboxIndex();
		if (idx < 0) return null;
		const e = imageGallery()[idx];
		if (!e?.mediaFullUrl) return null;
		return {
			eventId: e.eventId,
			fullUrl: e.mediaFullUrl,
			mimetype: e.mediaMimetype,
			size: e.mediaSize,
			filename: e.mediaFilename,
			width: e.mediaWidth,
			height: e.mediaHeight,
			senderName: e.senderName,
			timestamp: e.timestamp,
			isEncrypted: e.mediaIsEncrypted,
			encryptedFile: e.mediaEncryptedFile,
		};
	});
	const hasPrev = (): boolean => lightboxIndex() > 0;
	const hasNext = (): boolean => {
		const idx = lightboxIndex();
		return idx >= 0 && idx < imageGallery().length - 1;
	};
	const goPrev = (): void => {
		const idx = lightboxIndex();
		if (idx > 0) setLightboxEventId(imageGallery()[idx - 1].eventId);
	};
	const goNext = (): void => {
		const idx = lightboxIndex();
		const g = imageGallery();
		if (idx >= 0 && idx < g.length - 1) {
			setLightboxEventId(g[idx + 1].eventId);
		}
	};

	return {
		/** Open the lightbox on an event id (or null to close). */
		openImage: setLightboxEventId,
		closeLightbox: () => setLightboxEventId(null),
		isOpen,
		currentImage,
		hasPrev,
		hasNext,
		goPrev,
		goNext,
	};
}
