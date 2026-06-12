import type { MatrixClient } from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import { formatBytes } from "../../../../lib/formatBytes";
import type { TimelineEvent } from "../../timeline/useTimeline";
import { inspectImage, type Thumbnail } from "./imageProcessing";
import {
	assertCanSendMedia,
	buildMediaContent,
	classifyFile,
} from "./mediaContent";
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
	/** Receives upload progress in the range 0..1. */
	onProgress?: (progress: number) => void;
}

/**
 * Upload a single queued attachment and send it as the appropriate media
 * event. For images this probes dimensions and, when large, generates and
 * uploads a thumbnail first. Encrypted rooms are rejected here (Phase 4 lifts
 * that). Returns the sent event content for assertion/testing.
 */
export async function uploadAndSend(
	client: MatrixClient,
	roomId: string,
	attachment: PendingAttachment,
	opts: UploadAndSendOptions = {},
): Promise<RoomMessageEventContent> {
	const room = client.getRoom(roomId);
	if (!room) throw new Error("Room not found");
	assertCanSendMedia(room);

	const file = attachment.file;
	await validateSize(client, file);

	const kind = attachment.kind;
	const filename = file.name || "file";

	// Image-only: decode once for intrinsic dimensions + an optional thumbnail.
	// Both are best-effort — a decode/thumbnail failure still sends the full
	// image (without w/h or thumbnail) rather than failing the whole attachment.
	let width = attachment.width;
	let height = attachment.height;
	let thumbnail: Thumbnail | null = null;
	let thumbContentUri: string | undefined;
	if (kind === "image") {
		try {
			const inspection = await inspectImage(file);
			width = inspection.width;
			height = inspection.height;
			if (inspection.thumbnail) {
				const thumbResp = await client.uploadContent(
					inspection.thumbnail.blob,
					{
						type: inspection.thumbnail.mimetype,
						name: `thumb-${filename}`,
					},
				);
				thumbnail = inspection.thumbnail;
				thumbContentUri = thumbResp.content_uri;
			}
		} catch {
			thumbnail = null;
			thumbContentUri = undefined;
		}
	}

	opts.onProgress?.(0);
	const resp = await client.uploadContent(file, {
		type: file.type || "application/octet-stream",
		name: filename,
		progressHandler: (p) => {
			if (p.total > 0) opts.onProgress?.(p.loaded / p.total);
		},
	});
	opts.onProgress?.(1);

	const content = buildMediaContent({
		kind,
		contentUri: resp.content_uri,
		filename,
		mimetype: file.type || "application/octet-stream",
		size: file.size,
		caption: attachment.caption,
		width,
		height,
		thumbnail:
			thumbnail && thumbContentUri
				? {
						contentUri: thumbContentUri,
						mimetype: thumbnail.mimetype,
						size: thumbnail.blob.size,
						w: thumbnail.width,
						h: thumbnail.height,
					}
				: undefined,
		replyTo: opts.replyTo,
	});

	await client.sendMessage(roomId, content);
	return content;
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
