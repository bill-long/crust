import type { Room } from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import type { AttachmentKind, BuildMediaContentArgs, MediaInfo } from "./types";

/** User-facing message for the Phase 0 encrypted-room limitation. */
export const ENCRYPTED_UNSUPPORTED_MESSAGE =
	"Sending attachments to encrypted rooms isn't supported yet";

/**
 * Thrown when media is queued for an encrypted room. Phase 0 ships
 * unencrypted-room support only; the encrypt path (and removal of this
 * guard) lands in Phase 4. Callers surface the message to the user.
 */
export class EncryptedRoomUnsupportedError extends Error {
	constructor() {
		super(ENCRYPTED_UNSUPPORTED_MESSAGE);
		this.name = "EncryptedRoomUnsupportedError";
	}
}

/** Classify a file into a Matrix media category from its MIME type. */
export function classifyFile(file: File): AttachmentKind {
	const type = file.type;
	if (type.startsWith("image/")) return "image";
	if (type.startsWith("video/")) return "video";
	if (type.startsWith("audio/")) return "audio";
	return "file";
}

/** Map an attachment kind to its Matrix `msgtype`. */
export function msgtypeForKind(kind: AttachmentKind): string {
	switch (kind) {
		case "image":
			return "m.image";
		case "video":
			return "m.video";
		case "audio":
			return "m.audio";
		default:
			return "m.file";
	}
}

/**
 * Throw if the room is encrypted. Centralizes the Phase 0 limitation so
 * Phase 4 can lift it in exactly one place.
 */
export function assertCanSendMedia(room: Room): void {
	if (room.hasEncryptionStateEvent()) {
		throw new EncryptedRoomUnsupportedError();
	}
}

/**
 * Build the event content for a media send. `body` carries the caption when
 * present (falling back to the filename), while `filename` is always set so
 * receivers that prefer it (see useTimeline's filename handling) display the
 * real name. When replying we attach only the reply relation — unlike text
 * sends we don't prepend a quoted body, since prefixing a filename with quote
 * lines is meaningless and rich clients render the reply from the relation.
 */
export function buildMediaContent(
	args: BuildMediaContentArgs,
): RoomMessageEventContent {
	const {
		kind,
		contentUri,
		filename,
		mimetype,
		size,
		caption,
		width,
		height,
		thumbnail,
		replyTo,
	} = args;

	const info: MediaInfo = { mimetype, size };
	if (typeof width === "number" && width > 0) info.w = width;
	if (typeof height === "number" && height > 0) info.h = height;
	if (thumbnail) {
		info.thumbnail_url = thumbnail.contentUri;
		info.thumbnail_info = {
			w: thumbnail.w,
			h: thumbnail.h,
			mimetype: thumbnail.mimetype,
			size: thumbnail.size,
		};
	}

	const trimmedCaption = caption?.trim();
	const content: Record<string, unknown> = {
		msgtype: msgtypeForKind(kind),
		body: trimmedCaption || filename,
		filename,
		url: contentUri,
		info,
	};

	if (replyTo) {
		content["m.relates_to"] = {
			"m.in_reply_to": { event_id: replyTo.eventId },
		};
	}

	return content as unknown as RoomMessageEventContent;
}
