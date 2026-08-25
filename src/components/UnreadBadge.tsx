import { type Component, Show } from "solid-js";

interface UnreadBadgeProps {
	/** Unread notification count; > 0 renders the numeric pill. */
	unread: number;
	/** Highlight (mention) count; > 0 turns the pill red. */
	highlight: number;
	/**
	 * Explicit marked-unread flag: renders a plain dot when `unread` is 0,
	 * so a room the user flagged stays visible without inventing a count.
	 */
	markedUnread?: boolean;
	/** Pill scale: "md" for list rows (h-5), "sm" for sidebar tiles (h-4). */
	size?: "sm" | "md";
	/** Positioning/layout classes from the call site (e.g. absolute corner). */
	class?: string;
}

/**
 * Unread indicator shared by the room list rows and the spaces-sidebar
 * tiles: a numeric pill when there are unread notifications (red when any
 * is a mention), or a small dot when the room is only explicitly marked
 * unread (MSC2867). Renders nothing when there is nothing to indicate.
 */
const UnreadBadge: Component<UnreadBadgeProps> = (props) => {
	return (
		<Show when={props.unread > 0 || props.markedUnread}>
			<Show
				when={props.unread > 0}
				fallback={
					<span
						class={`block h-2.5 w-2.5 shrink-0 rounded-full bg-indicator ${props.class ?? ""}`}
						role="status"
						aria-label="Marked unread"
						title="Marked unread"
					/>
				}
			>
				<span
					class={`flex items-center justify-center rounded-full px-1 text-[10px] font-bold text-text-primary ${
						props.size === "sm" ? "h-4 min-w-4" : "h-5 min-w-5"
					} ${props.highlight > 0 ? "bg-danger" : "bg-indicator"} ${props.class ?? ""}`}
					role="status"
					aria-label={`${props.unread} unread${props.highlight > 0 ? `, ${props.highlight} highlighted` : ""}`}
				>
					{props.unread > 99 ? "99+" : props.unread}
				</span>
			</Show>
		</Show>
	);
};

export { UnreadBadge };
