import type { MatrixEvent, Room, Thread } from "matrix-js-sdk";
import { ThreadEvent } from "matrix-js-sdk";
import {
	buildProvisionalThreadSummary,
	buildThreadSummaryFromThread,
	type ThreadSummary,
} from "./threadSummary";

/**
 * Owns the SDK thread subscriptions for the timeline and converts them
 * into plain {@link ThreadSummary} data plus `onUpdate(rootId)` callbacks
 * that re-project the root's timeline row (mirrors createPollWatcher).
 *
 * Simpler than the poll watcher: the Room re-emits every Thread's
 * `ThreadEvent.Update` / `NewReply` / `Delete` (wired by `createThread`),
 * so one room-level subscription set covers all threads - no per-object
 * listeners, no lazy relations fetch. Note `ThreadEvent.*` is NOT
 * re-emitted on the client, only on the Room.
 */
export interface ThreadWatcher {
	/**
	 * Point the watcher at a room. Idempotent for the same room; switching
	 * rooms drops all cached summaries and room listeners.
	 */
	watchRoom(room: Room): void;
	/**
	 * Synchronously resolve the {@link ThreadSummary} for a thread ROOT
	 * event, for use inside the timeline projector. Cache first, then a
	 * live `Thread` object, then the root's server-aggregated bundle.
	 * Returns null when the event heads no thread (no chip).
	 */
	getSummary(rootEvent: MatrixEvent, room: Room): ThreadSummary | null;
	/**
	 * Drop tracking for every projected id NOT in `visible` (the store's
	 * current event ids). Without this the projected set - which records
	 * EVERY projected row, since any message can become a root later -
	 * grows monotonically as the user paginates through a room.
	 */
	pruneProjected(visible: ReadonlySet<string>): void;
	/** Remove every SDK listener and drop all cached state. */
	dispose(): void;
}

export function createThreadWatcher(
	onUpdate: (rootId: string) => void,
): ThreadWatcher {
	let watchedRoom: Room | null = null;
	/** Latest computed summary per projected root. */
	const summaries = new Map<string, ThreadSummary>();
	/** Every projected event id (not just roots). Membership means "a
	 *  ThreadEvent for this id should re-project the row" - so a plain
	 *  message that only later becomes a thread root gets its chip live,
	 *  the moment the first reply creates the Thread. */
	const projectedEvents = new Set<string>();

	function summariesEqual(a: ThreadSummary, b: ThreadSummary): boolean {
		return (
			a.threadId === b.threadId &&
			a.replyCount === b.replyCount &&
			a.latestSender === b.latestSender &&
			a.latestTs === b.latestTs &&
			a.currentUserParticipated === b.currentUserParticipated &&
			a.provisional === b.provisional
		);
	}

	function recompute(thread: Thread): void {
		if (!projectedEvents.has(thread.id)) return;
		const summary = buildThreadSummaryFromThread(thread);
		const cached = summaries.get(thread.id);
		if (summary) {
			// The SDK fires BOTH NewReply and Update for each incoming reply;
			// skipping the identical second pass halves the root-row
			// re-projections (reaction scan, reply resolution, poll parse) on
			// the live-message hot path.
			if (cached && summariesEqual(cached, summary)) return;
			summaries.set(thread.id, summary);
		} else {
			if (!cached) return;
			summaries.delete(thread.id);
		}
		onUpdate(thread.id);
	}

	function onThreadDelete(thread: Thread): void {
		if (!projectedEvents.has(thread.id)) return;
		summaries.delete(thread.id);
		onUpdate(thread.id);
	}

	function detachRoom(): void {
		if (!watchedRoom) return;
		watchedRoom.off(ThreadEvent.Update, recompute);
		watchedRoom.off(ThreadEvent.NewReply, recompute);
		watchedRoom.off(ThreadEvent.Delete, onThreadDelete);
		watchedRoom = null;
	}

	return {
		watchRoom(room: Room): void {
			if (watchedRoom?.roomId === room.roomId) return;
			detachRoom();
			summaries.clear();
			projectedEvents.clear();
			watchedRoom = room;
			// ThreadEvent.New (a brand-new thread) is always followed by
			// Update from updateThreadMetadata, so Update+NewReply+Delete
			// cover the full lifecycle.
			room.on(ThreadEvent.Update, recompute);
			room.on(ThreadEvent.NewReply, recompute);
			room.on(ThreadEvent.Delete, onThreadDelete);
		},

		getSummary(rootEvent: MatrixEvent, room: Room): ThreadSummary | null {
			const rootId = rootEvent.getId();
			if (!rootId) return null;
			// A projection for a room other than the watched one (transient
			// during room switches) gets a throwaway summary: caching would
			// leak state across rooms.
			const isWatchedRoom = watchedRoom?.roomId === room.roomId;
			if (isWatchedRoom) {
				projectedEvents.add(rootId);
				const cached = summaries.get(rootId);
				if (cached) return cached;
			}
			// Optional call: mock rooms without thread support read as "no
			// Thread object", falling through to the provisional bundle.
			const thread = room.getThread?.(rootId) ?? null;
			// A live Thread that hasn't fetched its initial events yet reads
			// length 0; fall back to the root's bundle so an existing chip
			// doesn't blink out during the fetch. Once fetched, the Thread
			// is authoritative (a fetched-and-empty thread means every reply
			// was redacted - no chip, even if a stale bundle disagrees).
			const summary = thread
				? (buildThreadSummaryFromThread(thread) ??
					(thread.initialEventsFetched
						? null
						: buildProvisionalThreadSummary(rootEvent)))
				: buildProvisionalThreadSummary(rootEvent);
			if (summary && isWatchedRoom) summaries.set(rootId, summary);
			return summary;
		},

		pruneProjected(visible: ReadonlySet<string>): void {
			for (const id of projectedEvents) {
				if (!visible.has(id)) projectedEvents.delete(id);
			}
			for (const id of summaries.keys()) {
				if (!visible.has(id)) summaries.delete(id);
			}
		},

		dispose(): void {
			detachRoom();
			summaries.clear();
			projectedEvents.clear();
		},
	};
}
