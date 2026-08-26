import { type Component, onMount } from "solid-js";

interface UnreadDividerProps {
	/**
	 * Called when the divider first renders. The virtualizer only mounts rows
	 * at or near the viewport, so being rendered at all means the user has
	 * reached the boundary - which is the cue to retire the jump affordance.
	 */
	onSeen?: () => void;
}

/**
 * "New messages" divider, rendered above the first row the user has not read.
 *
 * Red, matching the convention Discord and Element share for this specific
 * element - it is the one marker users scan for when returning to a busy room,
 * and inventing a colour for it would cost more than the semantic overload of
 * reusing the danger ramp.
 */
const UnreadDivider: Component<UnreadDividerProps> = (props) => {
	onMount(() => props.onSeen?.());

	return (
		<div class="flex items-center gap-3 px-4 pt-4 pb-2 text-[11px] font-semibold tracking-wider text-danger-text uppercase select-none">
			<div class="h-px flex-1 bg-danger" aria-hidden="true" />
			<span>New messages</span>
			<div class="h-px flex-1 bg-danger" aria-hidden="true" />
		</div>
	);
};

export { UnreadDivider };
