import { type Component, Show } from "solid-js";

interface NewerMessagesLoaderProps {
	/** A forward pagination is in flight. */
	loadingNewer: boolean;
	/** Show the manual "Load newer messages" button (more recent events remain
	 *  beyond the loaded slice). */
	showLoadNewerButton: boolean;
	/** Trigger a manual forward pagination. */
	onLoadNewer: () => void;
}

/**
 * Forward-pagination affordances rendered below the message list: a loading
 * spinner while paging, or a manual "Load newer messages" button when the loaded
 * slice trails the live end. Purely presentational - the timeline owns the
 * pagination state and the click side effects.
 */
const NewerMessagesLoader: Component<NewerMessagesLoaderProps> = (props) => (
	<>
		{/* Loading newer messages indicator */}
		<Show when={props.loadingNewer}>
			<div class="flex justify-center py-3" role="status" aria-live="polite">
				<span class="sr-only">Loading newer messages</span>
				<div
					class="h-5 w-5 animate-spin rounded-full border-2 border-border-default border-t-accent-hover"
					aria-hidden="true"
				/>
			</div>
		</Show>
		{/* Manual load button for newer messages */}
		<Show when={props.showLoadNewerButton}>
			<div class="flex justify-center py-3">
				<button
					type="button"
					class="rounded px-3 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-emphasis"
					onClick={() => props.onLoadNewer()}
				>
					Load newer messages
				</button>
			</div>
		</Show>
	</>
);

export { NewerMessagesLoader };
