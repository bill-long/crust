import type { Component } from "solid-js";

interface JumpToUnreadButtonProps {
	/** Scroll the first unread row into view. The timeline owns the jump. */
	onClick: () => void;
}

/**
 * Affordance that takes the user to where they left off. Positioned by the
 * timeline's floating-control stack rather than anchoring itself: the
 * scroll-to-bottom button below it comes and goes, so a fixed offset would
 * leave it hanging over empty space.
 */
const JumpToUnreadButton: Component<JumpToUnreadButtonProps> = (props) => (
	<button
		type="button"
		class="flex items-center gap-1 rounded-full bg-surface-3 px-3 py-2 text-text-secondary shadow-lg transition-colors hover:bg-surface-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
		onClick={props.onClick}
		// Starts with the visible label so voice control can match what the
		// user reads ("click Unread"), then says where it goes.
		aria-label="Unread: jump to first unread message"
	>
		<span aria-hidden="true">↑</span>
		<span class="text-xs">Unread</span>
	</button>
);

export { JumpToUnreadButton };
