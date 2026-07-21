import { type Component, onCleanup, Show } from "solid-js";

interface ComposerActionStripProps {
	/** True while editing a message - hides the GIF button (edits are
	 *  text-only replacements). */
	editing: boolean;
	/** GIF search is configured and available. */
	gifAvailable: boolean;
	/** GIF picker open state, for aria-expanded. */
	gifOpen: boolean;
	/** Emoji picker open state, for aria-expanded. */
	emojiOpen: boolean;
	/** Make the strip inert (the recording bar overlays it, and its buttons
	 *  must not be reachable underneath). */
	inert?: boolean;
	/** Toggle the GIF picker (and close the emoji picker). */
	onToggleGif: () => void;
	/** Toggle the emoji picker (and close the GIF picker). */
	onToggleEmoji: () => void;
	/** Report the measured strip width so the composer can reserve exactly this
	 *  much textarea padding. */
	onMeasure: (width: number) => void;
	/** Ref callback for the GIF button, so the composer can anchor/focus the
	 *  GIF picker popover it owns. */
	gifButtonRef: (el: HTMLButtonElement) => void;
	/** Ref callback for the emoji button, so the composer can focus it when the
	 *  emoji picker popover it owns closes. */
	emojiButtonRef: (el: HTMLButtonElement) => void;
}

/**
 * The composer action strip: one flex row of picker trigger buttons (GIF,
 * emoji) anchored to the bottom-right of the textarea. Everything else
 * (attach, poll, event, voice) lives in the "+" menu on the left
 * (ComposerPlusMenu), Discord-style, so the right edge stays uncluttered.
 * One flex row instead of per-button absolute offsets, so adding/hiding
 * buttons never requires recomputing right-N positions or the textarea
 * padding (the textarea reserves this strip's measured width, reported via
 * onMeasure).
 *
 * Purely presentational: the composer owns the pickers; the strip only
 * triggers callbacks. The GIF/emoji picker popovers live in the composer,
 * so their trigger buttons forward refs back out.
 */
const ComposerActionStrip: Component<ComposerActionStripProps> = (props) => {
	return (
		<div
			ref={(el) => {
				// Deferred to the next frame: writing the padding inside the
				// observer callback perturbs layout in the same frame and trips
				// the browser's "ResizeObserver loop" error. The pending frame is
				// tracked so cleanup can cancel it (no setter call after dispose)
				// and rapid fires coalesce.
				let raf = 0;
				const observer = new ResizeObserver(() => {
					cancelAnimationFrame(raf);
					raf = requestAnimationFrame(() => props.onMeasure(el.offsetWidth));
				});
				observer.observe(el);
				onCleanup(() => {
					cancelAnimationFrame(raf);
					observer.disconnect();
				});
			}}
			inert={props.inert || undefined}
			class="absolute bottom-2.5 right-2 flex items-center gap-1"
		>
			{/* GIF picker button (only when GIF search is available and not editing) */}
			<Show when={props.gifAvailable && !props.editing}>
				<button
					ref={props.gifButtonRef}
					type="button"
					class="rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
					onClick={() => props.onToggleGif()}
					aria-label="Open GIF picker"
					aria-expanded={props.gifOpen}
				>
					GIF
				</button>
			</Show>
			{/* Emoji picker button */}
			<button
				ref={props.emojiButtonRef}
				type="button"
				class="rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
				onClick={() => props.onToggleEmoji()}
				aria-label="Open emoji picker"
				aria-expanded={props.emojiOpen}
			>
				😀
			</button>
		</div>
	);
};

export { ComposerActionStrip };
