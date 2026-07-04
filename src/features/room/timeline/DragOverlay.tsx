import type { Component } from "solid-js";

/**
 * Full-bleed "Drop files to upload" overlay shown while files are dragged over
 * the timeline. `pointer-events-none` is essential: it keeps the overlay from
 * becoming the drag target, so crossing onto it doesn't fire a dragleave on the
 * content below and flicker the overlay. The drop still bubbles up to the
 * timeline <main> from the child under the cursor.
 */
const DragOverlay: Component = () => (
	<div
		class="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-surface-1/80"
		aria-hidden="true"
	>
		<div class="rounded-xl border-2 border-dashed border-accent-hover bg-surface-2/90 px-8 py-6 text-sm font-medium text-text-emphasis shadow-lg">
			Drop files to upload
		</div>
	</div>
);

export { DragOverlay };
