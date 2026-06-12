import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import type { AttachmentKind, BuildMediaContentArgs, MediaInfo } from "./types";

/**
 * Require exactly one of an encrypted `file` and a cleartext `contentUri`.
 * `file`/`contentUri` are both optional in the args so a caller can supply
 * either, but emitting both (or neither) yields malformed event content
 * (`url: undefined`, or a `url` *and* a `file`). Fail closed instead.
 */
function assertExactlyOneSource(
	file: unknown,
	contentUri: unknown,
	what: string,
): void {
	if (!file === !contentUri) {
		throw new Error(
			`buildMediaContent: ${what} must have exactly one of file / contentUri`,
		);
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
 * Build the event content for a media send. `body` carries the caption when
 * present (falling back to the filename), while `filename` is always set so
 * receivers that prefer it (see useTimeline's filename handling) display the
 * real name. When replying we attach only the reply relation — unlike text
 * sends we don't prepend a quoted body, since prefixing a filename with quote
 * lines is meaningless and rich clients render the reply from the relation.
 *
 * For encrypted rooms the caller passes `file` (and `thumbnail.file`): we emit
 * `content.file` / `info.thumbnail_file` (the ciphertext EncryptedFile blocks)
 * instead of `content.url` / `info.thumbnail_url`. The `info` block stays
 * cleartext either way so receivers can read the mimetype/size/dimensions.
 */
export function buildMediaContent(
	args: BuildMediaContentArgs,
): RoomMessageEventContent {
	const {
		kind,
		contentUri,
		file,
		filename,
		mimetype,
		size,
		caption,
		width,
		height,
		thumbnail,
		replyTo,
	} = args;

	// Fail closed on malformed input: emitting neither (or both) of file/url
	// would produce invalid event content rather than a clear error.
	assertExactlyOneSource(file, contentUri, "attachment");

	const info: MediaInfo = { mimetype, size };
	if (typeof width === "number" && width > 0) info.w = width;
	if (typeof height === "number" && height > 0) info.h = height;
	if (thumbnail) {
		assertExactlyOneSource(thumbnail.file, thumbnail.contentUri, "thumbnail");
		// Encrypted thumbnail → `thumbnail_file`; cleartext → `thumbnail_url`.
		if (thumbnail.file) {
			info.thumbnail_file = thumbnail.file;
		} else {
			info.thumbnail_url = thumbnail.contentUri;
		}
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
		info,
	};
	// Encrypted attachments carry ciphertext via `file`; plain ones via `url`.
	if (file) {
		content.file = file;
	} else {
		content.url = contentUri;
	}

	if (replyTo) {
		content["m.relates_to"] = {
			"m.in_reply_to": { event_id: replyTo.eventId },
		};
	}

	return content as unknown as RoomMessageEventContent;
}
