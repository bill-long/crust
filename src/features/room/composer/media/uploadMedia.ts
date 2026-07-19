import type { MatrixClient } from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import { formatBytes } from "../../../../lib/formatBytes";
import type { TimelineEvent } from "../../timeline/useTimeline";
import { type EncryptedFile, encryptAttachment } from "./attachmentCrypto";
import { sanitizeFilename } from "./filename";
import { inspectImage, type Thumbnail } from "./imageProcessing";
import { buildMediaContent, classifyFile } from "./mediaContent";
import type { PendingAttachment } from "./types";

/** Per-client cache of the homeserver's `m.upload.size` (null = no limit advertised). */
const uploadSizeCache = new WeakMap<MatrixClient, Promise<number | null>>();

function getMaxUploadSize(client: MatrixClient): Promise<number | null> {
	let cached = uploadSizeCache.get(client);
	if (!cached) {
		cached = client
			.getMediaConfig()
			.then((cfg) => {
				const size = cfg?.["m.upload.size"];
				return typeof size === "number" && size > 0 ? size : null;
			})
			.catch((e) => {
				// Don't cache a transient failure as "no limit" — drop it so the
				// next send re-fetches the config.
				uploadSizeCache.delete(client);
				throw e;
			});
		uploadSizeCache.set(client, cached);
	}
	return cached;
}

/**
 * Validate a file against the homeserver's advertised upload limit. Throws a
 * user-facing error when the file is too large; silently passes when no limit
 * is advertised or the config can't be fetched.
 */
export async function validateSize(
	client: MatrixClient,
	file: File,
): Promise<void> {
	let max: number | null;
	try {
		max = await getMaxUploadSize(client);
	} catch {
		// Couldn't fetch the limit — let the upload proceed and surface any
		// server-side rejection rather than blocking on an unknown limit.
		return;
	}
	if (max !== null && file.size > max) {
		throw new Error(
			`File is too large (${formatBytes(file.size)}). The server limit is ${formatBytes(max)}.`,
		);
	}
}

export interface UploadAndSendOptions {
	replyTo?: TimelineEvent | null;
	/** Thread scope: routes the send into this thread (SDK 3-arg
	 *  overload builds the MSC3440 relation). Null/absent = main. */
	threadId?: string | null;
	/** Receives upload progress in the range 0..1. */
	onProgress?: (progress: number) => void;
}

/**
 * Result of uploading one blob: a plain mxc url or an EncryptedFile. The field
 * names match {@link BuildMediaContentArgs} (and its `thumbnail`) so the result
 * spreads straight into either.
 */
type UploadedBlob = { contentUri: string } | { file: EncryptedFile };

/**
 * Upload a blob's bytes and return how to reference them. In encrypted rooms we
 * encrypt the bytes first and upload opaque ciphertext as
 * `application/octet-stream` with no filename — the server never sees the real
 * type or name — returning the full {@link EncryptedFile}. Otherwise we upload
 * the cleartext blob with its real type/name and return the mxc url.
 *
 * Exported for send paths that attach media to non-message events (the
 * event-card cover image, #418) so the encryption/upload policy lives in
 * exactly one place.
 */
export async function uploadBlob(
	client: MatrixClient,
	blob: Blob,
	opts: {
		encrypted: boolean;
		type: string;
		name?: string;
		progressHandler?: (p: { loaded: number; total: number }) => void;
	},
): Promise<UploadedBlob> {
	if (opts.encrypted) {
		const { ciphertext, file } = await encryptAttachment(
			await blob.arrayBuffer(),
		);
		const resp = await client.uploadContent(new Blob([ciphertext]), {
			type: "application/octet-stream",
			progressHandler: opts.progressHandler,
		});
		return { file: { ...file, url: resp.content_uri } };
	}
	const resp = await client.uploadContent(blob, {
		type: opts.type,
		name: opts.name,
		progressHandler: opts.progressHandler,
	});
	return { contentUri: resp.content_uri };
}

/**
 * Upload a single queued attachment and send it as the appropriate media
 * event. For images this probes dimensions and generates a thumbnail; the full
 * file is uploaded first and the thumbnail only after it succeeds (best-effort),
 * so a failed full upload can't orphan a thumbnail on the server. In encrypted
 * rooms the file (and thumbnail) bytes are AES-256-CTR encrypted and the event
 * carries `content.file` / `info.thumbnail_file` instead of cleartext urls.
 * Returns the sent event content for assertion/testing.
 */
export async function uploadAndSend(
	client: MatrixClient,
	roomId: string,
	attachment: PendingAttachment,
	opts: UploadAndSendOptions = {},
): Promise<RoomMessageEventContent> {
	const room = client.getRoom(roomId);
	if (!room) throw new Error("Room not found");
	// Authoritative encryption decision, made once at send time from the pinned
	// room: encrypted rooms get the ciphertext path, everything else plain.
	const encrypted = room.hasEncryptionStateEvent();

	const file = attachment.file;
	await validateSize(client, file);

	const kind = attachment.kind;
	const filename = sanitizeFilename(file.name);

	// Image-only: decode once for intrinsic dimensions + an optional thumbnail
	// blob. Best-effort — a decode failure still sends the full image (without
	// w/h or thumbnail). We don't upload the thumbnail yet; the full file goes
	// first so a failed full upload can't orphan a thumbnail MXC.
	let width = attachment.width;
	let height = attachment.height;
	let thumbnail: Thumbnail | null = null;
	if (kind === "image") {
		try {
			const inspection = await inspectImage(file);
			width = inspection.width;
			height = inspection.height;
			thumbnail = inspection.thumbnail;
		} catch {
			thumbnail = null;
		}
	}

	const mimetype = file.type || "application/octet-stream";
	opts.onProgress?.(0);
	const uploaded = await uploadBlob(client, file, {
		encrypted,
		type: mimetype,
		name: filename,
		progressHandler: (p) => {
			if (p.total > 0) opts.onProgress?.(p.loaded / p.total);
		},
	});
	opts.onProgress?.(1);

	// Best-effort thumbnail upload, only after the full upload succeeded — so a
	// full-upload failure never leaves an unreferenced thumbnail on the server.
	let thumbUploaded: UploadedBlob | undefined;
	if (thumbnail) {
		try {
			thumbUploaded = await uploadBlob(client, thumbnail.blob, {
				encrypted,
				type: thumbnail.mimetype,
				name: `thumb-${filename}`,
			});
		} catch {
			thumbnail = null;
			thumbUploaded = undefined;
		}
	}

	const content = buildMediaContent({
		kind,
		...uploaded,
		filename,
		mimetype,
		size: file.size,
		caption: attachment.caption,
		width,
		height,
		thumbnail:
			thumbnail && thumbUploaded
				? {
						...thumbUploaded,
						mimetype: thumbnail.mimetype,
						size: thumbnail.blob.size,
						w: thumbnail.width,
						h: thumbnail.height,
					}
				: undefined,
		replyTo: opts.replyTo,
		voice: attachment.voice,
	});

	await client.sendMessage(roomId, opts.threadId ?? null, content);
	return content;
}

/**
 * Upload a cover image for an event card (#418): encrypts in E2EE rooms
 * (same policy as composer sends), probes intrinsic dimensions, and
 * returns the m.image-style fields for the event block. Unlike composer
 * image sends, a failed dimension probe REJECTS the image: the card
 * reserves its layout from info.w/h, so shipping without dimensions would
 * reintroduce layout shift.
 */
export async function uploadEventImage(
	client: MatrixClient,
	roomId: string,
	file: File,
): Promise<{
	url?: string;
	file?: EncryptedFile;
	info: { w: number; h: number; mimetype: string; size: number };
}> {
	const room = client.getRoom(roomId);
	if (!room) throw new Error("Room not found");
	await validateSize(client, file);
	let inspection: Awaited<ReturnType<typeof inspectImage>>;
	try {
		inspection = await inspectImage(file);
	} catch {
		// createImageBitmap decode failures surface as bare DOMExceptions;
		// this message is shown verbatim in the Create Event dialog.
		throw new Error(
			"Couldn't read the cover image dimensions. Try a different file.",
		);
	}
	const uploaded = await uploadBlob(client, file, {
		encrypted: room.hasEncryptionStateEvent(),
		type: file.type || "application/octet-stream",
		name: sanitizeFilename(file.name),
	});
	// uploadBlob returns { contentUri } for plain rooms / { file } for E2EE;
	// the event block's m.image-style field is named `url`, so normalize
	// here — spreading the raw result would silently drop the cleartext
	// reference and the cover would never render in unencrypted rooms.
	const reference =
		"contentUri" in uploaded
			? { url: uploaded.contentUri }
			: { file: uploaded.file };
	return {
		...reference,
		info: {
			w: inspection.width,
			h: inspection.height,
			mimetype: file.type || "application/octet-stream",
			size: file.size,
		},
	};
}

/**
 * Build a {@link PendingAttachment} from a raw File, classifying it and
 * minting an object URL preview for images. Callers (paste/attach/drop) hand
 * the result to the composer queue.
 */
export function createPendingAttachment(file: File): PendingAttachment {
	const kind = classifyFile(file);
	return {
		id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
		file,
		kind,
		previewUrl: kind === "image" ? URL.createObjectURL(file) : null,
		caption: "",
		status: "ready",
		progress: 0,
	};
}
