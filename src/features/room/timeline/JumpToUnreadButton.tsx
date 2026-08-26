import type { Component } from "solid-js";

interface JumpToUnreadButtonProps {
	/** Scroll the first unread row into view. The timeline owns the jump. */
	onClick: () => void;
}

/**
 * Floating affordance that takes the user to where they left off, stacked
 * above the scroll-to-bottom button. Only offered while the divider is off
 * screen - once it is in view there is nothing left to point at.
 */
const JumpToUnreadButton: Component<JumpToUnreadButtonProps> = (props) => (
	<button
		type="button"
		class="absolute bottom-16 right-4 z-10 flex items-center gap-1 rounded-full bg-surface-3 px-3 py-2 text-text-secondary shadow-lg transition-colors hover:bg-surface-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
		onClick={props.onClick}
		aria-label="Jump to first unread message"
	>
		<span aria-hidden="true">↑</span>
		<span class="text-xs">Unread</span>
	</button>
);

export { JumpToUnreadButton };
