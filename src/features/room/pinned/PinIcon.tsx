import type { Component } from "solid-js";

/**
 * Push-pin icon. `filled` toggles between the outline (default) and solid
 * (currently-pinned) variants. The path is vertically symmetric around the
 * shaft axis with a distinct head + collar + needle, matching the rest of
 * the toolbar's 24x24 / stroke-width 2 icon convention (Lucide "pin" shape).
 */
const PinIcon: Component<{ filled?: boolean; class?: string }> = (props) => (
	<svg
		aria-hidden="true"
		viewBox="0 0 24 24"
		fill={props.filled ? "currentColor" : "none"}
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		class={props.class ?? "h-4 w-4"}
	>
		<line x1="12" y1="17" x2="12" y2="22" />
		<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
	</svg>
);

export { PinIcon };
