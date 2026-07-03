import {
	MatrixEvent,
	type Room,
	type Thread,
	ThreadEvent,
} from "matrix-js-sdk";

/**
 * Resolve (or create) the `Thread` object for a root event and wait for
 * its initial relations fetch, so the thread panel can mount a
 * TimelineWindow over `thread.timelineSet` without racing the SDK's
 * live-timeline reset (`updateThreadMetadata` resets the timeline when it
 * back-paginates the thread's history).
 *
 * The root is normally already loaded (the panel opens from a rendered
 * root row), so `room.findEventById` resolves it. A notification
 * deep-link (issue #303 step 3e) can target a thread whose root has
 * scrolled out of / never entered the loaded window, so as a fallback we
 * fetch the root from the server before creating the Thread.
 */
export async function ensureThread(
	room: Room,
	threadId: string,
): Promise<Thread | null> {
	let thread = room.getThread(threadId);
	if (!thread) {
		const rootEvent =
			room.findEventById(threadId) ?? (await fetchRootEvent(room, threadId));
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

/**
 * Fetch a thread root from the server for a deep-link into an unloaded
 * thread. Returns null on any failure (network, redacted, gone) so the
 * caller renders the panel's "couldn't load" state instead of throwing.
 * The fetched root is wrapped in a MatrixEvent and, in an encrypted room,
 * decrypted before it heads the Thread - otherwise a freshly-constructed
 * event nobody schedules for decryption would render the root row as a
 * permanent "Encrypted message" even with the keys present.
 */
async function fetchRootEvent(
	room: Room,
	threadId: string,
): Promise<MatrixEvent | null> {
	try {
		const raw = await room.client.fetchRoomEvent(room.roomId, threadId);
		if (!raw?.event_id) return null;
		const event = new MatrixEvent(raw);
		// No-op for unencrypted events; decrypts (using cached keys) otherwise.
		await room.client.decryptEventIfNeeded(event);
		return event;
	} catch {
		return null;
	}
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
