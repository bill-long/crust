import { stripReplyFallback } from "../../../lib/replyFallback";
import { TEXT_MSGTYPES, type TimelineEvent } from "./timelineTypes";

/**
 * Text the "Copy text" action offers for an event, or null when there is
 * no user-authored text to copy (so the menu item is omitted):
 *
 * - text-like messages ({@link TEXT_MSGTYPES}): the body with the legacy
 *   `> ` reply-fallback preamble stripped and surrounding whitespace
 *   trimmed, matching the sibling forward-as-text normalization
 *   (`forwardMessage.ts`);
 * - captioned media: the caption;
 * - decryption failures: nothing (the body is not readable content).
 */
export function copyableText(ev: TimelineEvent): string | null {
	if (ev.isDecryptionFailure) return null;
	if (TEXT_MSGTYPES.has(ev.msgtype)) {
		const text = stripReplyFallback(ev.body).trim();
		return text !== "" ? text : null;
	}
	const caption = ev.mediaCaption?.trim();
	return caption ? caption : null;
}
