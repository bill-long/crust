import { type Component, Show } from "solid-js";

interface ScrollToBottomButtonProps {
	/** True when there are newer messages beyond the loaded slice. Switches the
	 *  affordance from a plain "scroll to bottom" to "jump to latest" and shows
	 *  the "New messages" pill. */
	behindLive: boolean;
	/** Scroll/jump back to the live end. The timeline owns the scroll-pin logic. */
	onClick: () => void;
}

/**
 * Button that returns the user to the live end, placed by the timeline's
 * floating-control stack. Purely presentational; the timeline decides between
 * a smooth scroll-to-bottom and a jump-to-live behind `onClick`.
 */
const ScrollToBottomButton: Component<ScrollToBottomButtonProps> = (props) => (
	<button
		type="button"
		class="flex items-center gap-1 rounded-full bg-surface-3 px-3 py-2 text-text-secondary shadow-lg transition-colors hover:bg-surface-4"
		onClick={props.onClick}
		aria-label={
			props.behindLive ? "Jump to latest messages" : "Scroll to bottom"
		}
	>
		<Show when={props.behindLive}>
			<span class="text-xs">New messages</span>
		</Show>
		<span>↓</span>
	</button>
);

export { ScrollToBottomButton };
