import { type Component, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { formatRelativeTime, useMinuteTick } from "../../../lib/relativeTime";
import type { ThreadSummary } from "./threadSummary";

/**
 * Compact "N replies" summary rendered under a thread root's message body
 * (beside the reaction pills). A button that opens the thread panel when
 * `onOpen` is provided; a plain summary otherwise (inside the panel).
 */

export const ThreadSummaryChip: Component<{
	thread: ThreadSummary;
	/** Opens the thread panel; when absent the chip is non-interactive. */
	onOpen?: () => void;
	/** Injectable clock for tests; when set, the ticker isn't subscribed. */
	now?: number;
}> = (props) => {
	// Keeps the "Nm ago" label honest on quiet threads: the row only
	// re-projects when the thread changes, so without a ticker the label
	// would freeze at projection time. The ticker is SHARED (one interval
	// across all chips). `now` is a static test seam, so reading it once
	// at setup is deliberate.
	const tick = props.now === undefined ? useMinuteTick() : null;

	const replyLabel = () =>
		props.thread.replyCount === 1
			? "1 reply"
			: `${props.thread.replyCount} replies`;
	const activity = () =>
		props.thread.latestTs !== null
			? formatRelativeTime(
					props.thread.latestTs,
					props.now ?? tick?.() ?? Date.now(),
				)
			: null;

	const hasUnread = () => props.thread.unreadCount > 0;

	const ariaLabel = () => {
		const act = activity();
		return `Open thread: ${replyLabel()}${act ? `, last activity ${act}` : ""}${
			hasUnread() ? ", unread" : ""
		}`;
	};

	return (
		<Dynamic
			component={props.onOpen ? "button" : "div"}
			{...(props.onOpen
				? {
						type: "button",
						onClick: props.onOpen,
						"aria-label": ariaLabel(),
					}
				: {})}
			class={`mt-1 inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-surface-2 px-2 py-0.5 text-xs text-text-secondary ${
				props.onOpen
					? "transition-colors hover:border-border-default hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
					: ""
			}`}
		>
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
			<Show when={hasUnread()}>
				{/* Unread indicator. The dot is decorative; the unread STATE
					(not a count) reaches AT via the button's aria-label suffix,
					and via this sr-only text on the non-interactive variant
					(a div has no aria-label to carry the suffix). */}
				<span
					class="h-1.5 w-1.5 shrink-0 rounded-full bg-indicator"
					aria-hidden="true"
				/>
				<Show when={!props.onOpen}>
					<span class="sr-only">unread</span>
				</Show>
			</Show>
		</Dynamic>
	);
};
