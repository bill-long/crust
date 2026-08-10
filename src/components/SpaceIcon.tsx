import type { Component } from "solid-js";

/**
 * Space glyph used for subspace rows in the room list and subspace entries
 * in space discovery (#443). Mirrors RoomList's ChannelTypeIcon sizing and
 * aria pattern so subspaces share the same name x-position as room rows.
 */
const SpaceIcon: Component = () => (
	<svg
		aria-label="Space"
		role="img"
		width="14"
		height="14"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		class="shrink-0 text-text-muted"
	>
		<rect x="2" y="2" width="12" height="12" rx="3" />
		<circle cx="8" cy="8" r="2.5" />
	</svg>
);

export { SpaceIcon };
