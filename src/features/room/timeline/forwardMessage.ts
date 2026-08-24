import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import type { RoomMessageEventContent } from "matrix-js-sdk/lib/@types/events";
import { stripReplyFallback } from "../../../lib/replyFallback";
import {
	decryptAttachment,
	parseEncryptedFile,
} from "../composer/media/attachmentCrypto";
import { uploadBlob } from "../composer/media/uploadMedia";
import { TEXT_MSGTYPES, type TimelineEvent } from "./timelineTypes";

/** Attachment types forwarded as media content (re-uploaded when needed). */
const MEDIA_MSGTYPES = new Set(["m.image", "m.video", "m.audio", "m.file"]);

/**
 * Whether a timeline event can be forwarded. Only server-confirmed
 * room messages of a supported msgtype qualify: local echoes (pending
 * or failed) have no server event to copy, decryption failures have no
 * readable content, and polls / stickers / custom events have no
 * forward representation. GIF rows are m.text (the body carries the GIF
 * URL) and forward as ordinary text.
 */
export function canForward(event: TimelineEvent): boolean {
	if (event.stateNotice) return false;
	if (event.status !== null) return false;
	if (event.isDecryptionFailure) return false;
	return TEXT_MSGTYPES.has(event.msgtype) || MEDIA_MSGTYPES.has(event.msgtype);
}

/**
 * The SDK's RoomMessageEventContent is a per-msgtype closed union; content
 * rebuilt dynamically from a source event can't be narrowed to one member
 * statically, so the builders below return generic records and
 * {@link forwardMessage} casts once at the send boundary.
 */
type ForwardContent = Record<string, unknown>;

/**
 * Strip the `<mx-reply>…</mx-reply>` quoted preamble from a formatted
 * body. The forward drops the reply relation, so carrying the quote
 * would attribute text the forwarder never wrote. String-level strip
 * (the send side builds this block with plain string concatenation in
 * buildMessageContent, so the shape is stable).
 */
function stripFormattedReplyFallback(formatted: string): string {
	return formatted.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/g, "").trim();
}

/**
 * Rebuild text-like content for the target room: post-edit body from
 * `getContent()`, reply relation and reply fallback removed. `m.new_content`
 * (an edit artifact) and `m.relates_to` (reply/thread) never survive a
 * forward - the forwarded message stands alone in the target room.
 */
function buildTextForwardContent(
	content: Record<string, unknown>,
): ForwardContent {
	const body = typeof content.body === "string" ? content.body : "";
	const out: Record<string, unknown> = {
		msgtype: content.msgtype,
		body: stripReplyFallback(body).trim(),
	};
	if (
		content.format === "org.matrix.custom.html" &&
		typeof content.formatted_body === "string"
	) {
		out.format = content.format;
		out.formatted_body = stripFormattedReplyFallback(content.formatted_body);
	}
	return out;
}

/** Keys in `info` that reference the *source* upload's thumbnail. After a
    re-upload the thumbnail MXC (and its decryption keys) no longer matches
    the new file, so the re-uploaded forward drops them - the target room
    renders from the full media instead. */
const THUMBNAIL_INFO_KEYS = [
	"thumbnail_url",
	"thumbnail_file",
	"thumbnail_info",
] as const;

function infoWithoutThumbnails(
	info: unknown,
): Record<string, unknown> | undefined {
	if (!info || typeof info !== "object") return undefined;
	const out = { ...(info as Record<string, unknown>) };
	for (const key of THUMBNAIL_INFO_KEYS) delete out[key];
	return out;
}

/**
 * Download the source attachment's plaintext bytes: a direct fetch for
 * cleartext media, or fetch + verify + decrypt for an encrypted one.
 * Throws (fails closed) on a malformed encrypted descriptor, hash
 * mismatch, or network failure - the caller surfaces it as the forward
 * error.
 */
async function downloadSourceBytes(
	client: MatrixClient,
	content: Record<string, unknown>,
): Promise<Blob> {
	const encryptedFile = parseEncryptedFile(content.file);
	const mxc =
		typeof content.url === "string"
			? content.url
			: typeof encryptedFile?.url === "string"
				? encryptedFile.url
				: null;
	if (!mxc) {
		throw new Error("The attachment has no downloadable media URL.");
	}
	const httpUrl = client.mxcUrlToHttp(mxc);
	if (!httpUrl) {
		throw new Error("The attachment has no downloadable media URL.");
	}
	const res = await fetch(httpUrl, { credentials: "omit" });
	if (!res.ok) {
		throw new Error(`Couldn't download the attachment (HTTP ${res.status}).`);
	}
	const bytes = await res.arrayBuffer();
	if (!encryptedFile) {
		return new Blob([bytes], {
			type: readMimetype(content) ?? "application/octet-stream",
		});
	}
	const plaintext = await decryptAttachment(bytes, encryptedFile);
	return new Blob([plaintext], {
		type: readMimetype(content) ?? "application/octet-stream",
	});
}

function readMimetype(content: Record<string, unknown>): string | null {
	const info = content.info;
	if (info && typeof info === "object") {
		const m = (info as Record<string, unknown>).mimetype;
		if (typeof m === "string" && m) return m;
	}
	return null;
}

/**
 * Rebuild media content for the target room. When the source is cleartext
 * AND the target room is unencrypted the event is copied verbatim (minus
 * the reply relation and fallback) - the same MXC stays valid. Whenever the encryption
 * side differs (encrypted source, encrypted target, or both) the bytes are
 * downloaded (decrypting the source when needed) and re-uploaded under the
 * target room's policy: encrypted attachment keys are per-upload, so a
 * verbatim copy into an encrypted room would also leak the plaintext MXC
 * reference shape the room's clients don't expect.
 */
async function buildMediaForwardContent(
	client: MatrixClient,
	content: Record<string, unknown>,
	targetRoomId: string,
): Promise<ForwardContent> {
	const targetRoom = client.getRoom(targetRoomId);
	if (!targetRoom) throw new Error("Target room not found");
	const targetEncrypted = targetRoom.hasEncryptionStateEvent();
	const sourceEncrypted = parseEncryptedFile(content.file) !== null;

	const rawBody = typeof content.body === "string" ? content.body : "";
	// Reply fallbacks live in `body` for media events too, so strip the
	// quoted preamble here exactly like the text path - the forward must
	// not attribute text the forwarder never wrote. Fall back to the raw
	// body if stripping empties it: a media body doubles as the caption.
	const body = stripReplyFallback(rawBody).trim() || rawBody.trim();
	const base: Record<string, unknown> = {
		msgtype: content.msgtype,
		body,
	};
	if (typeof content.filename === "string") base.filename = content.filename;
	// Voice-message and other top-level rendering hints ride along in both
	// paths (they describe the recording, not the upload).
	if (
		content["org.matrix.msc3245.voice"] &&
		typeof content["org.matrix.msc3245.voice"] === "object"
	) {
		base["org.matrix.msc3245.voice"] = content["org.matrix.msc3245.voice"];
	}

	if (!sourceEncrypted && !targetEncrypted && typeof content.url === "string") {
		base.url = content.url;
		if (content.info && typeof content.info === "object") {
			base.info = content.info;
		}
		return base;
	}

	const blob = await downloadSourceBytes(client, content);
	const uploaded = await uploadBlob(client, blob, {
		encrypted: targetEncrypted,
		type: readMimetype(content) ?? "application/octet-stream",
		name:
			typeof content.filename === "string"
				? content.filename
				: body || undefined,
	});
	const info = infoWithoutThumbnails(content.info) ?? {};
	info.size = blob.size;
	// uploadBlob returns { contentUri } for plain rooms / { file } for E2EE;
	// the event field is named `url`, so normalize here - spreading the raw
	// result would silently drop the cleartext reference (same shape bug
	// uploadEventImage guards against).
	const reference =
		"contentUri" in uploaded
			? { url: uploaded.contentUri }
			: { file: uploaded.file };
	return {
		...base,
		...reference,
		info,
	};
}

/**
 * Forward a message to another room. Rebuilds content from the source
 * event (post-edit), strips reply/thread relations, and re-uploads media
 * when the encryption policy differs between source and target. Throws on
 * unsupported msgtypes and any download/upload/send failure; the caller
 * owns the error surface.
 */
export async function forwardMessage(
	client: MatrixClient,
	source: MatrixEvent,
	targetRoomId: string,
): Promise<void> {
	const content = source.getContent() as Record<string, unknown>;
	const msgtype = content.msgtype;
	let forwardContent: ForwardContent;
	if (typeof msgtype === "string" && TEXT_MSGTYPES.has(msgtype)) {
		forwardContent = buildTextForwardContent(content);
	} else if (typeof msgtype === "string" && MEDIA_MSGTYPES.has(msgtype)) {
		forwardContent = await buildMediaForwardContent(
			client,
			content,
			targetRoomId,
		);
	} else {
		throw new Error("This message type can't be forwarded.");
	}
	// Single cast at the send boundary (see ForwardContent): the rebuilt
	// record is a valid event body for its msgtype by construction.
	await client.sendMessage(
		targetRoomId,
		null,
		forwardContent as unknown as RoomMessageEventContent,
	);
}
