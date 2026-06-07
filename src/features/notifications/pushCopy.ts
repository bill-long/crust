/**
 * Pure notification-copy helpers for background Web Push, shared by the service
 * worker (src/sw.ts). Kept DOM/worker-free so the copy decisions can be
 * unit-tested. Mirrors the in-app notification copy in
 * src/features/room/useNotifications.ts.
 */

/** Subset of the push payload the notification copy reads. The payload is
 *  operator/homeserver-influenced JSON, typed only by assertion at the parse
 *  site, so consumers must tolerate missing/non-string fields. */
export interface PushPayload {
	event_id?: string;
	room_id?: string;
	room_name?: string;
	room_alias?: string;
	sender?: string;
	sender_display_name?: string;
	type?: string;
	unread?: number;
	content?: { body?: string; msgtype?: string };
}

/** Trim a push-payload field, tolerating non-string values: the payload is
 *  user-influenced JSON, so a non-string (number, object, …) must not reach
 *  `.trim()` (which would throw). Returns "" for any non-string. */
export function trimmedField(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** Describe an event's content for a notification. `isText` distinguishes a
 *  literal message body (joined to the sender with ": ") from an action phrase
 *  like "sent an image" (joined with a space). */
function describeContent(payload: PushPayload): {
	isText: boolean;
	text: string;
} {
	const content = payload.content;
	switch (content?.msgtype) {
		case "m.image":
			return { isText: false, text: "sent an image" };
		case "m.file":
			return { isText: false, text: "sent a file" };
		case "m.audio":
			return { isText: false, text: "sent an audio file" };
		case "m.video":
			return { isText: false, text: "sent a video" };
		default: {
			const body =
				typeof content?.body === "string" ? content.body.slice(0, 200) : "";
			if (body) return { isText: true, text: body };
			// No readable body. For an encrypted event the homeserver/Sygnal
			// forward ciphertext only (no msgtype/body), so show a clear
			// encrypted-message label with a lock indicator — mirroring the
			// in-app decryption-failure copy in useNotifications.ts — rather than
			// the vague "New message" used for a genuinely empty body.
			if (payload.type === "m.room.encrypted") {
				return { isText: true, text: "🔒 Encrypted message" };
			}
			return { isText: true, text: "New message" };
		}
	}
}

/** Compose the notification title and body from a push payload. In a named
 *  room/space, the room leads the title and the message is attributed to the
 *  sender in the body. In a DM (no distinct room name), the sender is the
 *  title, so the body is just the message/action without repeating the sender.
 *  User-controlled names are trimmed so whitespace-only values don't produce a
 *  blank title (matches the in-app path). */
export function buildNotificationCopy(payload: PushPayload): {
	title: string;
	body: string;
} {
	const sender =
		trimmedField(payload.sender_display_name) ||
		trimmedField(payload.sender) ||
		"Someone";
	const room =
		trimmedField(payload.room_name) || trimmedField(payload.room_alias);
	const { isText, text } = describeContent(payload);
	const senderLine = isText ? `${sender}: ${text}` : `${sender} ${text}`;
	const inRoom = room !== "" && room !== sender;
	return {
		title: inRoom ? room : sender,
		body: inRoom ? senderLine : text,
	};
}
