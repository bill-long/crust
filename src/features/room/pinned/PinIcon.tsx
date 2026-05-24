import type { Component } from "solid-js";

/**
 * Pin icon. `filled` toggles between the outline (default) and solid
 * (currently-pinned) variants. The two SVG paths share the same bounding
 * box so they're visually interchangeable in the same slot.
 */
const PinIcon: Component<{ filled?: boolean; class?: string }> = (props) => (
	<svg
		aria-hidden="true"
		viewBox="0 0 16 16"
		width="16"
		height="16"
		fill={props.filled ? "currentColor" : "none"}
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		class={props.class}
	>
		{/* Stylized pushpin: head at top, shaft angled toward bottom-left */}
		<path d="M10.5 1.5l4 4-2 1-1.5 1.5 1 4-4-2.5-3.5 3.5-1-1 3.5-3.5L4.5 4l4-1z" />
	</svg>
);

export { PinIcon };
