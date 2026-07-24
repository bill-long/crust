import {
	type MatrixEvent,
	NotificationCountType,
	type Room,
	THREAD_RELATION_TYPE,
	type Thread,
} from "matrix-js-sdk";

/**
 * Plain-data summary of a thread for the root event's timeline row.
 * Mirrors the PollSnapshot pattern: the render layer never touches SDK
 * objects, so the watcher folds these into projection instead.
 */
export interface ThreadSummary {
	/** Thread ID = the root event's ID. */
	threadId: string;
	/**
	 * Reply count. From a live Thread this is `thread.length`, which
	 * INCLUDES the user's own pending sends (optimistic - a just-sent
	 * reply counts immediately). A failed send keeps counting until it
	 * is retried or discarded; the compose-into-threads step (#303 3d)
	 * owns that retry/discard lifecycle.
	 */
	replyCount: number;
	/** Sender of the latest reply, or null when unknown. */
	latestSender: string | null;
	/** origin_server_ts of the latest reply, or null when unknown. */
	latestTs: number | null;
	/** Whether the current user has participated in the thread. */
	currentUserParticipated: boolean;
	/**
	 * Unread notification count for this thread (Total). Drives the chip's
	 * unread dot; 0 means read. Sourced from the room's per-thread counter
	 * (populated by `unread_thread_notifications` in /sync, MSC3771/3773),
	 * so it silently reads 0 on servers that don't advertise that support.
	 */
	unreadCount: number;
	/**
	 * True when built from the root's server-aggregated bundle only (no
	 * live Thread object yet) - counts are correct as of the last sync
	 * that bundled them, and upgrade automatically once a Thread exists.
	 */
	provisional: boolean;
}

/** Per-thread unread count from the room's counter (populated by
 *  `unread_thread_notifications` in /sync, MSC3771/3773). Optional call:
 *  mock rooms and servers without that support read 0. Shared by the
 *  timeline chip watcher and the room-wide thread list. */
export function threadUnreadCount(room: Room, threadId: string): number {
	return (
		room.getThreadUnreadNotificationCount?.(
			threadId,
			NotificationCountType.Total,
		) ?? 0
	);
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
	unreadCount = 0,
): ThreadSummary | null {
	const rootId = rootEvent.getId();
	if (!rootId) return null;
	// Optional call: defensive against partial event fakes (the
	// isRelation precedent) - a missing accessor reads as "no bundle".
	// Server-latched relation name, not a literal, so the bundle key
	// stays in sync with the SDK partition on pre-stable servers.
	const bundle = rootEvent.getServerAggregatedRelation?.<ThreadBundle>(
		THREAD_RELATION_TYPE.name,
	);
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
		unreadCount: Math.max(0, unreadCount),
		provisional: true,
	};
}

/**
 * Summary from a live `Thread` object. `thread.length` counts confirmed
 * replies plus the user's own pending sends (see the replyCount doc);
 * the latest-reply fields tolerate an absent/undecryptable last event.
 * Returns null for a thread with no replies (no chip).
 */
export function buildThreadSummaryFromThread(
	thread: Thread,
	unreadCount = 0,
): ThreadSummary | null {
	const replyCount = thread.length;
	if (!replyCount || replyCount <= 0) return null;
	// replyToEvent already ends in `?? lastReply()` internally.
	const last = thread.replyToEvent ?? null;
	return {
		threadId: thread.id,
		replyCount,
		latestSender: last?.getSender() ?? null,
		latestTs: last?.getTs() ?? null,
		currentUserParticipated: thread.hasCurrentUserParticipated,
		unreadCount: Math.max(0, unreadCount),
		provisional: false,
	};
}
