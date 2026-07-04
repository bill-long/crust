import { type Component, Show } from "solid-js";
import type { TimelineEvent } from "../timeline/useTimeline";

interface ComposerContextBannerProps {
	/** The message being edited, if edit mode is active. Takes precedence over
	 *  a reply (you can't reply and edit at once). */
	editingEvent?: TimelineEvent | null;
	/** The message being replied to, shown only when not editing. */
	replyTo?: TimelineEvent | null;
	/** Cancel the in-progress edit (clears the draft and exits edit mode). */
	onCancelEdit: () => void;
	/** Cancel the pending reply. */
	onCancelReply: () => void;
}

/**
 * The context strip above the composer input: an "Editing message" banner while
 * editing, or a reply preview while replying. Mutually exclusive - editing wins.
 * Purely presentational; the composer owns the edit/reply state and the cancel
 * side effects.
 */
const ComposerContextBanner: Component<ComposerContextBannerProps> = (
	props,
) => {
	return (
		<>
			<Show when={props.editingEvent}>
				{(editing) => (
					<div class="mb-2 flex items-center gap-2 rounded bg-surface-2/50 px-3 py-1.5">
						<div class="min-w-0 flex-1 border-l-2 border-info-border pl-2">
							<p class="truncate text-xs font-medium text-info-text">
								Editing message
							</p>
							<p class="truncate text-xs text-text-disabled">
								{editing().body.trim() || "Message"}
							</p>
						</div>
						<button
							type="button"
							class="shrink-0 rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary"
							onClick={() => props.onCancelEdit()}
							aria-label="Cancel edit"
						>
							✕
						</button>
					</div>
				)}
			</Show>
			<Show when={!props.editingEvent && props.replyTo}>
				{(reply) => (
					<div class="mb-2 flex items-center gap-2 rounded bg-surface-2/50 px-3 py-1.5">
						<div class="min-w-0 flex-1 border-l-2 border-accent-hover pl-2">
							<p class="truncate text-xs font-medium text-text-muted">
								{reply().senderName.trim() || "Unknown"}
							</p>
							<p class="truncate text-xs text-text-disabled">
								{reply().body.trim() || "Message"}
							</p>
						</div>
						<button
							type="button"
							class="shrink-0 rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary"
							onClick={() => props.onCancelReply()}
							aria-label="Cancel reply"
						>
							✕
						</button>
					</div>
				)}
			</Show>
		</>
	);
};

export { ComposerContextBanner };
