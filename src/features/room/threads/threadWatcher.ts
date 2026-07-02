import type { MatrixClient, MatrixEvent, Room, Thread } from "matrix-js-sdk";
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
	/** Remove every SDK listener and drop all cached state. */
	dispose(): void;
}

export function createThreadWatcher(
	_client: MatrixClient,
	onUpdate: (rootId: string) => void,
): ThreadWatcher {
	let watchedRoom: Room | null = null;
	/** Latest computed summary per projected root. */
	const summaries = new Map<string, ThreadSummary>();
	/** Roots that have been projected at least once - gates the room-level
	 *  handlers so only threads with a visible row trigger re-projection. */
	const projectedRoots = new Set<string>();

	function recompute(thread: Thread): void {
		if (!projectedRoots.has(thread.id)) return;
		const summary = buildThreadSummaryFromThread(thread);
		if (summary) {
			summaries.set(thread.id, summary);
		} else {
			summaries.delete(thread.id);
		}
		onUpdate(thread.id);
	}

	function onThreadUpdate(thread: Thread): void {
		recompute(thread);
	}

	function onThreadNewReply(thread: Thread): void {
		recompute(thread);
	}

	function onThreadDelete(thread: Thread): void {
		if (!projectedRoots.has(thread.id)) return;
		summaries.delete(thread.id);
		onUpdate(thread.id);
	}

	function detachRoom(): void {
		if (!watchedRoom) return;
		watchedRoom.off(ThreadEvent.Update, onThreadUpdate);
		watchedRoom.off(ThreadEvent.NewReply, onThreadNewReply);
		watchedRoom.off(ThreadEvent.Delete, onThreadDelete);
		watchedRoom = null;
	}

	return {
		watchRoom(room: Room): void {
			if (watchedRoom?.roomId === room.roomId) return;
			detachRoom();
			summaries.clear();
			projectedRoots.clear();
			watchedRoom = room;
			// ThreadEvent.New (a brand-new thread) is always followed by
			// Update from updateThreadMetadata, so Update+NewReply+Delete
			// cover the full lifecycle.
			room.on(ThreadEvent.Update, onThreadUpdate);
			room.on(ThreadEvent.NewReply, onThreadNewReply);
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
				projectedRoots.add(rootId);
				const cached = summaries.get(rootId);
				if (cached) return cached;
			}
			// Optional call: mock rooms without thread support read as "no
			// Thread object", falling through to the provisional bundle.
			const thread = room.getThread?.(rootId) ?? null;
			const summary = thread
				? buildThreadSummaryFromThread(thread)
				: buildProvisionalThreadSummary(rootEvent);
			if (summary && isWatchedRoom) summaries.set(rootId, summary);
			return summary;
		},

		dispose(): void {
			detachRoom();
			summaries.clear();
			projectedRoots.clear();
		},
	};
}
