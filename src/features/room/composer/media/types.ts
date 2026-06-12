import type { TimelineEvent } from "../../timeline/useTimeline";

/** Broad media category derived from a file's MIME type. */
export type AttachmentKind = "image" | "video" | "audio" | "file";

/** Lifecycle of a queued attachment as it moves toward being sent. */
export type AttachmentStatus = "ready" | "uploading" | "error";

/**
 * A file the user has queued in the composer but not yet sent. Drives the
 * attachment tray UI and is consumed by {@link uploadAndSend}.
 */
export interface PendingAttachment {
	/** Stable id for keying UI rows and targeting removal. */
	id: string;
	file: File;
	kind: AttachmentKind;
	/** Object URL for image previews; `null` for non-image kinds. Revoked on removal. */
	previewUrl: string | null;
	/** Optional per-attachment caption. */
	caption: string;
	/**
	 * Optional caller-provided intrinsic dimensions. The upload path probes
	 * images itself, so these are only a fallback and are not populated by the
	 * queue today.
	 */
	width?: number;
	height?: number;
	status: AttachmentStatus;
	/** Upload progress in the range 0..1. */
	progress: number;
	error?: string;
}

/** Matrix `info` block for an image/video event, including optional thumbnail. */
export interface MediaInfo {
	w?: number;
	h?: number;
	mimetype: string;
	size: number;
	thumbnail_url?: string;
	thumbnail_info?: {
		w: number;
		h: number;
		mimetype: string;
		size: number;
	};
}

/** Arguments for {@link buildMediaContent}. */
export interface BuildMediaContentArgs {
	kind: AttachmentKind;
	/** mxc:// URI returned from uploading the file. */
	contentUri: string;
	filename: string;
	mimetype: string;
	size: number;
	caption?: string;
	width?: number;
	height?: number;
	thumbnail?: {
		contentUri: string;
		mimetype: string;
		size: number;
		w: number;
		h: number;
	};
	/** Event being replied to, if any — attaches the reply relation. */
	replyTo?: TimelineEvent | null;
}
