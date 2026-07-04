import { type Component, Show } from "solid-js";

interface OlderMessagesLoaderProps {
	/** A backward pagination is in flight. */
	loadingOlder: boolean;
	/** Show the manual "Load older messages" button (auto-pagination has been
	 *  exhausted but more history remains). */
	showLoadOlderButton: boolean;
	/** The start of the room's history has been reached. */
	atBeginning: boolean;
	/** Trigger a manual backward pagination. */
	onLoadOlder: () => void;
}

/**
 * Backward-pagination affordances rendered above the message list: a loading
 * spinner while paging, a manual "Load older messages" button once
 * auto-pagination is exhausted, or a "Beginning of conversation" marker at the
 * top of history. Purely presentational - the timeline owns the pagination
 * state and derives which state is active.
 */
const OlderMessagesLoader: Component<OlderMessagesLoaderProps> = (props) => (
	<>
		{/* Loading older messages indicator */}
		<Show when={props.loadingOlder}>
			<div class="flex justify-center py-3">
				<div class="h-5 w-5 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
			</div>
		</Show>
		{/* Manual load button when auto-pagination exhausted */}
		<Show when={props.showLoadOlderButton}>
			<div class="flex justify-center py-3">
				<button
					type="button"
					class="rounded px-3 py-1 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-emphasis"
					onClick={() => props.onLoadOlder()}
				>
					Load older messages
				</button>
			</div>
		</Show>
		<Show when={props.atBeginning}>
			<div class="py-3 text-center text-xs text-text-disabled">
				Beginning of conversation
			</div>
		</Show>
	</>
);

export { OlderMessagesLoader };
