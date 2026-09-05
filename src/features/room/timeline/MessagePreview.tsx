import type { Component } from "solid-js";
import { isAttachmentMsgtype } from "../../../lib/filename";
import type { TimelineEvent } from "./timelineTypes";

/**
 * One-line preview text for a message: its body, or a generic label for
 * body-less events (media, stickers). Shared by the forward / delete /
 * report dialogs so the fallback policy can't fork per dialog.
 */
export function messagePreviewText(
	event: Pick<
		TimelineEvent,
		"body" | "mediaCaption" | "mediaFilename" | "msgtype"
	>,
): string {
	if (isAttachmentMsgtype(event.msgtype)) {
		return event.mediaCaption || event.mediaFilename || "Attachment";
	}
	return event.body.trim() || "Attachment";
}

/** Boxed one-line message preview used inside the delete/report dialogs. */
const MessagePreview: Component<{ event: TimelineEvent }> = (props) => (
	<p class="truncate rounded bg-surface-2 px-3 py-2 text-text-muted">
		{messagePreviewText(props.event)}
	</p>
);

export { MessagePreview };
