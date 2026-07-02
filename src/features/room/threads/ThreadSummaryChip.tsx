import { type Component, Show } from "solid-js";
import type { ThreadSummary } from "./threadSummary";

/**
 * Compact "N replies" summary rendered under a thread root's message body
 * (beside the reaction pills). Non-interactive for now: it becomes the
 * open-thread button when the thread panel lands (issue #303 step 3c).
 */

/** Coarse relative-activity label (mirrors DeviceItem's local helper). */
function formatLatestActivity(ts: number, now: number): string {
	const diffMs = Math.max(0, now - ts);
	const diffMins = Math.floor(diffMs / 60_000);
	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays < 7) return `${diffDays}d ago`;
	return new Date(ts).toLocaleDateString();
}

export const ThreadSummaryChip: Component<{
	thread: ThreadSummary;
	/** Injectable clock for tests; defaults to Date.now at render. */
	now?: number;
}> = (props) => {
	const replyLabel = () =>
		props.thread.replyCount === 1
			? "1 reply"
			: `${props.thread.replyCount} replies`;
	const activity = () =>
		props.thread.latestTs !== null
			? formatLatestActivity(props.thread.latestTs, props.now ?? Date.now())
			: null;

	return (
		<div class="mt-1 inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-2 py-0.5 text-xs text-text-secondary">
			<svg
				class="h-3.5 w-3.5 shrink-0 text-text-muted"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
			</svg>
			<span class="font-medium text-accent-text">{replyLabel()}</span>
			<Show when={activity()}>
				{(label) => <span class="text-text-muted">{label()}</span>}
			</Show>
		</div>
	);
};
