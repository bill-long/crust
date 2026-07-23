import { type Accessor, batch, createSignal } from "solid-js";

export interface ThreadPanelState {
	/** Root event id of the thread shown in the panel, or null when closed. */
	openThreadId: Accessor<string | null>;
	/** Jump target INSIDE the open thread (a pin/search hit that is a
	 *  thread reply). Consumed by the panel's TimelineView via
	 *  {@link consumeJump}; replaced on every open so a stale target can't
	 *  fire inside a thread opened later for another reason. */
	threadJumpRequest: Accessor<string | null>;
	open: (threadId: string, jumpToEventId?: string) => void;
	close: () => void;
	consumeJump: () => void;
}

/**
 * Signal pair driving the thread panel: which thread is open, and an
 * optional event to scroll its timeline to (issue #334).
 *
 * `open` writes both signals in one batch. This is load-bearing, not
 * style: without it, effects flush between the writes, so when thread A's
 * panel is already mounted and a jump targets thread B, A's still-mounted
 * TimelineView jump effect would see the new request first - running a
 * wrong-thread window load AND consuming the request - before the keyed
 * `<Show>` remounts the panel for B, which would then mount with nothing
 * to scroll to. Batched, the panel switch and the request land together;
 * A's subtree is disposed during the update phase, so only B's mount-time
 * jump effect ever reads the target.
 */
export function createThreadPanelState(): ThreadPanelState {
	const [openThreadId, setOpenThreadId] = createSignal<string | null>(null);
	const [threadJumpRequest, setThreadJumpRequest] = createSignal<string | null>(
		null,
	);
	return {
		openThreadId,
		threadJumpRequest,
		open: (threadId, jumpToEventId) => {
			batch(() => {
				setThreadJumpRequest(jumpToEventId ?? null);
				setOpenThreadId(threadId);
			});
		},
		close: () => {
			batch(() => {
				setOpenThreadId(null);
				setThreadJumpRequest(null);
			});
		},
		consumeJump: () => setThreadJumpRequest(null),
	};
}
