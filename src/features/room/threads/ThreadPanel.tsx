import {
	type Component,
	createResource,
	Match,
	onCleanup,
	onMount,
	Switch,
} from "solid-js";
import { useClient } from "../../../client/client";
import { TimelineView } from "../timeline/TimelineView";
import { ensureThread } from "./ensureThread";

/**
 * Right-hand thread panel: the full timeline machinery (TimelineView with
 * a thread source) over one thread's timeline. Read-only until
 * compose-into-threads lands (issue #303 step 3d).
 *
 * Mounting waits for {@link ensureThread} so the TimelineWindow never
 * races the SDK's initial relations backfill (which resets the thread's
 * live timeline).
 */
export const ThreadPanel: Component<{
	roomId: string;
	threadId: string;
	onClose: () => void;
}> = (props) => {
	const { client } = useClient();
	const [thread] = createResource(
		() => ({ roomId: props.roomId, threadId: props.threadId }),
		async ({ roomId, threadId }) => {
			const room = client.getRoom(roomId);
			if (!room) return null;
			return await ensureThread(room, threadId);
		},
	);

	// Focus lands inside the panel on open so the Escape handler is live
	// on desktop (the mobile Dialog manages its own focus); the previously
	// focused element (usually the chip) gets focus back on close.
	let sectionRef: HTMLElement | undefined;
	const previouslyFocused =
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	onMount(() => sectionRef?.focus());
	onCleanup(() => {
		if (previouslyFocused?.isConnected) previouslyFocused.focus();
	});

	return (
		<section
			ref={sectionRef}
			tabindex="-1"
			class="flex h-full min-w-0 flex-col overflow-hidden focus-visible:outline-none"
			aria-label="Thread"
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.stopPropagation();
					props.onClose();
				}
			}}
		>
			<div class="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-3">
				<h2 class="text-sm font-semibold text-text-emphasis">Thread</h2>
				<button
					type="button"
					class="inline-flex h-8 w-8 items-center justify-center rounded text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
					onClick={() => props.onClose()}
					aria-label="Close thread"
				>
					<svg
						class="h-4 w-4"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						aria-hidden="true"
					>
						<path d="M18 6 6 18" />
						<path d="m6 6 12 12" />
					</svg>
				</button>
			</div>
			<Switch>
				<Match when={thread.error}>
					<div class="flex flex-1 items-center justify-center px-4 text-center text-sm text-text-muted">
						Couldn't load this thread
					</div>
				</Match>
				<Match when={thread.loading}>
					<div class="flex flex-1 items-center justify-center text-sm text-text-muted">
						Loading thread…
					</div>
				</Match>
				<Match when={thread() === null && !thread.loading}>
					<div class="flex flex-1 items-center justify-center px-4 text-center text-sm text-text-muted">
						Couldn't load this thread
					</div>
				</Match>
				<Match when={thread()}>
					<div class="min-h-0 flex-1">
						<TimelineView
							roomId={props.roomId}
							thread={{ threadId: props.threadId }}
						/>
					</div>
				</Match>
			</Switch>
		</section>
	);
};
