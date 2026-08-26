import { type Component, onCleanup, onMount } from "solid-js";

interface UnreadDividerProps {
	/**
	 * Called once the divider has actually been in the viewport. That is the
	 * cue to retire the jump affordance, so it has to mean "the user saw it",
	 * not merely "it exists" - the virtualizer mounts overscan rows above the
	 * fold, and retiring on those would take the affordance away from someone
	 * who never reached the boundary.
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
	let el: HTMLDivElement | undefined;

	onMount(() => {
		// No IntersectionObserver: fall back to treating the row's existence
		// as having seen it. Retiring the affordance slightly early beats
		// leaving it up forever with no way to dismiss it.
		if (typeof IntersectionObserver === "undefined" || !el) {
			props.onSeen?.();
			return;
		}
		const observer = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				props.onSeen?.();
				observer.disconnect();
			}
		});
		observer.observe(el);
		onCleanup(() => observer.disconnect());
	});

	return (
		<div
			ref={el}
			class="flex items-center gap-3 px-4 pt-4 pb-2 text-[11px] font-semibold tracking-wider text-danger-text uppercase select-none"
		>
			<div class="h-px flex-1 bg-danger" aria-hidden="true" />
			<span>New messages</span>
			<div class="h-px flex-1 bg-danger" aria-hidden="true" />
		</div>
	);
};

export { UnreadDivider };
