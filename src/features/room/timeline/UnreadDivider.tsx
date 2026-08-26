import { type Component, onCleanup, onMount } from "solid-js";

interface UnreadDividerProps {
	/**
	 * Called as the divider scrolls in and out of the timeline viewport, and
	 * with `false` when it unmounts (the virtualizer recycles the row once it
	 * is far enough away). Drives whether the jump affordance is offered:
	 * there is no point pointing at something already on screen.
	 *
	 * Never called at all when the browser has no `IntersectionObserver`.
	 * That is deliberate - the caller starts in an "unknown" state that
	 * withholds the affordance, so the failure mode is a missing button
	 * rather than one pointing at a divider in plain view.
	 */
	onVisibilityChange?: (visible: boolean) => void;
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
		if (!el) return;
		// Feature-detected: jsdom and older embedders have no
		// IntersectionObserver, and the divider itself must still render.
		if (typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver((entries) => {
			for (const entry of entries)
				props.onVisibilityChange?.(entry.isIntersecting);
		});
		observer.observe(el);
		onCleanup(() => {
			observer.disconnect();
			props.onVisibilityChange?.(false);
		});
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
