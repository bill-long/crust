import { type Component, createSignal, onCleanup, Show } from "solid-js";
import { formatRelativeTime } from "../../../lib/relativeTime";
import type { ThreadSummary } from "./threadSummary";

/**
 * Compact "N replies" summary rendered under a thread root's message body
 * (beside the reaction pills). Non-interactive for now: it becomes the
 * open-thread button when the thread panel lands (issue #303 step 3c).
 */

/** Relative labels have minute granularity, so tick once a minute. */
const TICK_MS = 60_000;

export const ThreadSummaryChip: Component<{
	thread: ThreadSummary;
	/** Injectable clock for tests; when set, it wins over the ticker. */
	now?: number;
}> = (props) => {
	// Keeps the "Nm ago" label honest on quiet threads: the row only
	// re-projects when the thread changes, so without a ticker the label
	// would freeze at projection time.
	const [tick, setTick] = createSignal(Date.now());
	const timer = setInterval(() => setTick(Date.now()), TICK_MS);
	onCleanup(() => clearInterval(timer));

	const replyLabel = () =>
		props.thread.replyCount === 1
			? "1 reply"
			: `${props.thread.replyCount} replies`;
	const activity = () =>
		props.thread.latestTs !== null
			? formatRelativeTime(props.thread.latestTs, props.now ?? tick())
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
