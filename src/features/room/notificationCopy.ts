import type { MatrixEvent } from "matrix-js-sdk";
import { isPollStartType, pollNotificationBody } from "../../lib/pollCopy";
import { isThreadReply } from "../../lib/threadEvents";
import { isVoiceMessageContent } from "../../lib/voiceMessage";

/**
 * Pure in-app notification body copy, split out from `useNotifications`
 * so the thread/media/poll wording is unit-testable without the browser
 * Notification harness. Mirrors `describeContent` in pushCopy.ts so the
 * in-app and background-push copy stay in agreement.
 *
 * `isText` distinguishes a literal message body (joined to the sender
 * with ": ") from an action phrase like "sent an image" (joined with a
 * space).
 */
function describeContent(
	event: MatrixEvent,
	content: Record<string, unknown>,
): { isText: boolean; text: string } {
	if (event.getType() === "m.sticker") {
		return { isText: false, text: "sent a sticker" };
	}
	// Polls carry no msgtype, so they're keyed on the event type before the
	// msgtype switch. Matches the room-list preview and push copy.
	if (isPollStartType(event.getType())) {
		return { isText: true, text: pollNotificationBody(content) };
	}
	switch (content.msgtype as string | undefined) {
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
				typeof content.body === "string" ? content.body.slice(0, 200) : "";
			return { isText: true, text: body || "New message" };
		}
	}
}

/**
 * Compose the notification body for `event`, attributed to `sender` (the
 * caller resolves the display name from room state). Thread replies get
 * "replied in a thread" framing so the reader knows the message lives in
 * a thread rather than the main timeline (as Element does).
 */
export function buildNotificationBody(
	event: MatrixEvent,
	sender: string,
): string {
	if (event.isDecryptionFailure()) {
		// Lock indicator matches the background-push copy in pushCopy.ts.
		return `${sender}: 🔒 Encrypted message`;
	}
	const { isText, text } = describeContent(event, event.getContent());
	if (isThreadReply(event)) {
		return isText
			? `${sender} replied in a thread: ${text}`
			: `${sender} replied in a thread`;
	}
	return isText ? `${sender}: ${text}` : `${sender} ${text}`;
}
