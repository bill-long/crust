import type { Room, Thread } from "matrix-js-sdk";
import { ThreadEvent } from "matrix-js-sdk";

/**
 * Resolve (or create) the `Thread` object for a root event and wait for
 * its initial relations fetch, so the thread panel can mount a
 * TimelineWindow over `thread.timelineSet` without racing the SDK's
 * live-timeline reset (`updateThreadMetadata` resets the timeline when it
 * back-paginates the thread's history).
 *
 * The panel only opens from a rendered root row, so the root event is
 * always available via `room.findEventById`; a fetch-root-from-server
 * branch is deliberately deferred until something needs it (e.g. a
 * notification deep-link to an unloaded thread, issue #303 step 3e).
 */
export async function ensureThread(
	room: Room,
	threadId: string,
): Promise<Thread | null> {
	let thread = room.getThread(threadId);
	if (!thread) {
		const rootEvent = room.findEventById(threadId);
		if (!rootEvent) return null;
		thread = room.createThread(threadId, rootEvent, [], false);
	}
	if (!thread.initialEventsFetched) {
		// updateThreadMetadata (kicked off by construction) resets the live
		// timeline and back-paginates via /relations; wait for one Update
		// emission, which fires after the fetch settles. Bounded so a
		// hung/failed fetch degrades to "window whatever is there" instead
		// of wedging the panel.
		await waitForInitialFetch(thread, 10_000);
	}
	return thread;
}

function waitForInitialFetch(thread: Thread, timeoutMs: number): Promise<void> {
	if (thread.initialEventsFetched) return Promise.resolve();
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const settle = (): void => {
			thread.off(ThreadEvent.Update, check);
			thread.off(ThreadEvent.Delete, settle);
			if (timer !== null) clearTimeout(timer);
			resolve();
		};
		const check = (): void => {
			if (!thread.initialEventsFetched) return;
			settle();
		};
		thread.on(ThreadEvent.Update, check);
		// A thread deleted mid-wait (root redacted) never fetches; settle
		// immediately so the caller can render its failure/empty state.
		thread.on(ThreadEvent.Delete, settle);
		timer = setTimeout(settle, timeoutMs);
		// The fetch may have completed between the guard and the subscribe.
		check();
	});
}
