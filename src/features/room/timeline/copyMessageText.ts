import { stripReplyFallback } from "../../../lib/replyFallback";
import { reportError } from "../../../lib/reportError";

/** Msgtypes whose `body` is user-authored text worth offering "Copy text" for. */
const COPYABLE_MSGTYPES = new Set(["m.text", "m.notice", "m.emote"]);

/** Whether the hover toolbar should offer "Copy text" for this event. */
export function isCopyableText(msgtype: string, body: string): boolean {
	return COPYABLE_MSGTYPES.has(msgtype) && body.length > 0;
}

/**
 * Copy a message body to the clipboard, with the legacy `> ` reply-fallback
 * preamble stripped so the copied text matches what the timeline renders.
 *
 * Success is silent (Discord-style; the copy is instant and the menu has
 * already closed). Failure - including a missing Clipboard API - surfaces a
 * toast via `reportError`: no inline affordance exists for this action, so
 * per the error-handling convention it gets a `userMessage`.
 */
export async function copyMessageText(body: string): Promise<void> {
	const text = stripReplyFallback(body);
	try {
		const clipboard =
			typeof navigator !== "undefined" ? navigator.clipboard : undefined;
		if (!clipboard?.writeText) {
			throw new Error("Clipboard API unavailable");
		}
		await clipboard.writeText(text);
	} catch (e) {
		reportError(e, {
			userMessage: "Couldn't copy the message text.",
			logLabel: "copyMessageText failed",
		});
	}
}
