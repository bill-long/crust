import type { MatrixEvent, Thread } from "matrix-js-sdk";

/**
 * Plain-data summary of a thread for the root event's timeline row.
 * Mirrors the PollSnapshot pattern: the render layer never touches SDK
 * objects, so the watcher folds these into projection instead.
 */
export interface ThreadSummary {
	/** Thread ID = the root event's ID. */
	threadId: string;
	/** Confirmed reply count (m.thread relations only, no pending). */
	replyCount: number;
	/** Sender of the latest reply, or null when unknown. */
	latestSender: string | null;
	/** origin_server_ts of the latest reply, or null when unknown. */
	latestTs: number | null;
	/** Whether the current user has participated in the thread. */
	currentUserParticipated: boolean;
	/**
	 * True when built from the root's server-aggregated bundle only (no
	 * live Thread object yet) - counts are correct as of the last sync
	 * that bundled them, and upgrade automatically once a Thread exists.
	 */
	provisional: boolean;
}

/** Shape of the server-aggregated m.thread bundle on a root event. */
interface ThreadBundle {
	count?: unknown;
	current_user_participated?: unknown;
	latest_event?: { sender?: unknown; origin_server_ts?: unknown } | null;
}

/**
 * Summary from the root event's bundled `m.thread` aggregation - the only
 * data available for roots paginated in before any live reply created a
 * `Thread` object. Returns null when the root carries no bundle (a root
 * with no replies has no chip).
 */
export function buildProvisionalThreadSummary(
	rootEvent: MatrixEvent,
): ThreadSummary | null {
	const rootId = rootEvent.getId();
	if (!rootId) return null;
	// Optional call: defensive against partial event fakes (the
	// isRelation precedent) - a missing accessor reads as "no bundle".
	const bundle =
		rootEvent.getServerAggregatedRelation?.<ThreadBundle>("m.thread");
	if (!bundle) return null;
	const count =
		typeof bundle.count === "number" && Number.isFinite(bundle.count)
			? Math.max(0, bundle.count)
			: 0;
	if (count === 0) return null;
	const latest = bundle.latest_event;
	return {
		threadId: rootId,
		replyCount: count,
		latestSender: typeof latest?.sender === "string" ? latest.sender : null,
		latestTs:
			typeof latest?.origin_server_ts === "number" &&
			Number.isFinite(latest.origin_server_ts)
				? latest.origin_server_ts
				: null,
		currentUserParticipated: bundle.current_user_participated === true,
		provisional: true,
	};
}

/**
 * Summary from a live `Thread` object. `replyCount` deliberately excludes
 * pending sends (under Chronological ordering the SDK never counts them
 * anyway); the latest-reply fields tolerate an absent/undecryptable last
 * event. Returns null for a thread with no replies (no chip).
 */
export function buildThreadSummaryFromThread(
	thread: Thread,
): ThreadSummary | null {
	const replyCount = thread.length;
	if (!replyCount || replyCount <= 0) return null;
	const last = thread.replyToEvent ?? thread.lastReply() ?? null;
	return {
		threadId: thread.id,
		replyCount,
		latestSender: last?.getSender() ?? null,
		latestTs: last?.getTs() ?? null,
		currentUserParticipated: thread.hasCurrentUserParticipated,
		provisional: false,
	};
}
