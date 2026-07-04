import { type Component, onCleanup, Show } from "solid-js";

interface ComposerActionStripProps {
	/** Voice recording is supported in this environment (static per session). */
	voiceSupported: boolean;
	/** True while editing a message - hides voice/poll/attach/gif (edits are
	 *  text-only replacements). */
	editing: boolean;
	/** True when composing in a thread - hides the poll button
	 *  (polls-in-threads are deferred, #303). */
	inThread: boolean;
	/** GIF search is configured and available. */
	gifAvailable: boolean;
	/** Poll dialog open state, for aria-expanded. */
	pollOpen: boolean;
	/** GIF picker open state, for aria-expanded. */
	gifOpen: boolean;
	/** Emoji picker open state, for aria-expanded. */
	emojiOpen: boolean;
	/** Make the strip inert (the recording bar overlays it, and its buttons
	 *  must not be reachable underneath). */
	inert?: boolean;
	/** Start a voice recording. */
	onStartRecording: () => void;
	/** Open the poll dialog (and close the pickers). */
	onOpenPoll: () => void;
	/** Files chosen via the hidden attach input. */
	onFileSelected: (e: Event & { currentTarget: HTMLInputElement }) => void;
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
 * The composer action strip: one flex row of trigger buttons (voice, poll,
 * attach, GIF, emoji) anchored to the bottom-right of the textarea. One flex
 * row instead of per-button absolute offsets, so adding/hiding buttons never
 * requires recomputing right-N positions or the textarea padding (the textarea
 * reserves this strip's measured width, reported via onMeasure).
 *
 * Purely presentational: the composer owns the pickers, the recorder, and the
 * file queue; the strip only triggers callbacks. The GIF/emoji picker popovers
 * live in the composer, so their trigger buttons forward refs back out.
 */
const ComposerActionStrip: Component<ComposerActionStripProps> = (props) => {
	let fileInputRef: HTMLInputElement | undefined;

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
			<Show when={props.voiceSupported && !props.editing}>
				<button
					type="button"
					class="rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
					onClick={() => props.onStartRecording()}
					aria-label="Record voice message"
				>
					<svg
						class="h-5 w-5"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<rect x="9" y="2" width="6" height="12" rx="3" />
						<path d="M5 10v1a7 7 0 0 0 14 0v-1" />
						<path d="M12 18v4" />
					</svg>
				</button>
			</Show>
			{/* Poll button (hidden when editing - polls are new sends - and in
			    threads: polls-in-threads are deferred, #303). */}
			<Show when={!props.editing && !props.inThread}>
				<button
					type="button"
					class="rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
					onClick={() => props.onOpenPoll()}
					aria-label="Create poll"
					aria-haspopup="dialog"
					aria-expanded={props.pollOpen}
				>
					<svg
						class="h-5 w-5"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						aria-hidden="true"
					>
						<path d="M6 20V10" />
						<path d="M12 20V4" />
						<path d="M18 20v-6" />
					</svg>
				</button>
			</Show>
			{/* Attach file button (hidden when editing - edits can't carry
			    attachments). The hidden input accepts images and arbitrary files;
			    non-media files are classified as m.file at send. */}
			<Show when={!props.editing}>
				<input
					ref={(el) => {
						fileInputRef = el;
					}}
					type="file"
					multiple
					data-composer-file-input
					class="hidden"
					onChange={props.onFileSelected}
				/>
				<button
					type="button"
					class="rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
					onClick={() => fileInputRef?.click()}
					aria-label="Attach file"
				>
					📎
				</button>
			</Show>
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
