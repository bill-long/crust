import type { Component } from "solid-js";

/**
 * One-line preview text for a message: its body, or a generic label for
 * body-less events (media, stickers). Shared by the forward / delete /
 * report dialogs so the fallback policy can't fork per dialog.
 */
export function messagePreviewText(body: string): string {
	return body.trim() || "Attachment";
}

/** Boxed one-line message preview used inside the delete/report dialogs. */
const MessagePreview: Component<{ body: string }> = (props) => (
	<p class="truncate rounded bg-surface-2 px-3 py-2 text-text-muted">
		{messagePreviewText(props.body)}
	</p>
);

export { MessagePreview };
