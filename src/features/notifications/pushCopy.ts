/**
 * Pure notification-copy helpers for background Web Push, shared by the service
 * worker (src/sw.ts). Kept DOM/worker-free so the copy decisions can be
 * unit-tested. Mirrors the in-app notification copy in
 * src/features/room/useNotifications.ts.
 */

import { stripBidiControls, stripLineBreakers } from "../../lib/controlChars";
import { displayNameOr } from "../../lib/displayName";
import { isPollStartType, pollNotificationBody } from "../../lib/pollCopy";
import { isVoiceMessageContent } from "../../lib/voiceMessage";

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
	/** Event content. Polls carry their payload under namespaced keys
	 *  (org.matrix.msc3381.poll.start), hence the open index signature. */
	content?: { body?: string; msgtype?: string; [key: string]: unknown };
}

/** Trim a push-payload field, tolerating non-string values: the payload is
 *  user-influenced JSON, so a non-string (number, object, …) must not reach
 *  `.trim()` (which would throw). Returns "" for any non-string.
 *
 *  For identifiers - `room_id`, `event_id` in the service worker - where
 *  surrounding whitespace is never meaningful. Names use {@link stringField}
 *  instead, because trimming them early defeats a length bound measured on
 *  the raw string. */
export function trimmedField(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** A push-payload field as a string, tolerating non-string values: the
 *  payload is user-influenced JSON, so a number or object must not reach
 *  `displayNameOr` (or `.trim()`, which would throw). Returns "" for any
 *  non-string.
 *
 *  Deliberately does NOT trim. `displayNameOr` tests its length bound against
 *  the RAW string before trimming, so pre-trimming would let a name behind
 *  2000 spaces past a bound the member list applies - the same user rendering
 *  two ways in two surfaces, which is the whole point of one policy. */
export function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Describe an event's content for a notification. `isText` distinguishes a
 *  literal message body (joined to the sender with ": ") from an action phrase
 *  like "sent an image" (joined with a space). */
function describeContent(payload: PushPayload): {
	isText: boolean;
	text: string;
} {
	const content = payload.content;
	// Polls carry no msgtype, so they're keyed on the event type before the
	// msgtype switch. Mirrors the in-app copy in useNotifications.ts.
	if (isPollStartType(payload.type ?? "")) {
		return { isText: true, text: pollNotificationBody(content) };
	}
	switch (content?.msgtype) {
		case "m.image":
			return { isText: false, text: "sent an image" };
		case "m.file":
			return { isText: false, text: "sent a file" };
		case "m.audio":
			return isVoiceMessageContent(content)
				? { isText: false, text: "sent a voice message" }
				: { isText: false, text: "sent an audio file" };
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
	// `sender_display_name` is homeserver/Sygnal-supplied and no `RoomMember`
	// has normalized it - and this renders in an OS notification, outside the
	// page, where nothing can contain a stray formatting character. The
	// `trimmedField` guard stays in front: the payload is untyped JSON, so a
	// non-string must not reach the policy.
	// Every field here is from the same untrusted payload, so all of them go
	// through the policy - wrapping only `sender_display_name` would just move
	// the character one field over, and a homeserver that controls one
	// controls all three.
	const sender =
		displayNameOr(stringField(payload.sender_display_name), "") ||
		displayNameOr(stringField(payload.sender), "") ||
		"Someone";
	// Room names are escaped at the sink, not run through the display-name
	// policy - the same choice `summaries` and `useNotifications` make, and
	// for the same reason: applying a person-name policy (its length bound
	// included) to a room name would show the same room under two names in
	// two places. Sygnal does derive this from the peer's member name for an
	// unnamed DM, which is why it needs escaping at all - and why the escape
	// is the same pair of strips the name policy applies (line breakers and
	// bidi scope controls): `inRoom` below compares this to the resolved
	// sender, and a DM with a peer named `Ann<LRE>Smith` must still frame as
	// a DM rather than putting the raw name in the title as a "room".
	const escapeRoomName = (s: string): string =>
		stripBidiControls(stripLineBreakers(s)).trim();
	const room =
		escapeRoomName(stringField(payload.room_name)) ||
		escapeRoomName(stringField(payload.room_alias));
	const { isText, text } = describeContent(payload);
	const inRoom = room !== "" && room !== sender;
	// Thread framing matches the in-app copy (notificationCopy.ts) so the two
	// notification paths agree. Best-effort on the push payload: the relation
	// is read from cleartext content, so an encrypted reply whose relation is
	// hidden falls back to plain copy (as it must).
	if (isThreadReplyPayload(payload)) {
		const threaded = isText
			? `replied in a thread: ${text}`
			: "replied in a thread";
		return {
			title: inRoom ? room : sender,
			body: inRoom ? `${sender} ${threaded}` : threaded,
		};
	}
	const senderLine = isText ? `${sender}: ${text}` : `${sender} ${text}`;
	return {
		title: inRoom ? room : sender,
		body: inRoom ? senderLine : text,
	};
}

/** Whether the push payload describes a thread reply. Reads the cleartext
 *  `m.relates_to` (the stable "m.thread" name continuwuity advertises);
 *  worker-safe, so it uses the literal rather than importing the SDK's
 *  latched constant. */
function isThreadReplyPayload(payload: PushPayload): boolean {
	const relatesTo = payload.content?.["m.relates_to"] as
		| { rel_type?: string; event_id?: string }
		| undefined;
	return (
		relatesTo?.rel_type === "m.thread" && typeof relatesTo.event_id === "string"
	);
}
