import type { EventTimelineSet, MatrixEvent, Room } from "matrix-js-sdk";
import { isThreadReply, isThreadTimelineData } from "../../../lib/threadEvents";

/**
 * Abstraction over WHICH timeline the useTimeline hook windows over: the
 * room's main (unfiltered) timeline set, or one thread's timeline set.
 * Concentrates all thread awareness of the windowing engine in one place
 * so the hook itself only makes mechanical substitutions (issue #317:
 * keep the 2300-line hook's diff minimal).
 */
export interface TimelineSource {
	/** Stable identity for effect keys ("main" or `thread:<rootId>`) -
	 *  changing the key reloads the window. */
	key: string;
	/** True when this source windows a thread timeline (flips the
	 *  displayability rule for thread replies and disables room-only
	 *  chrome like typing and call notices). */
	inThread: boolean;
	/** The timeline set to window over, or null when it doesn't exist
	 *  yet (a thread not yet materialized - callers gate on this). */
	getTimelineSet(room: Room): EventTimelineSet | null;
	/** Whether a timeline set belongs to this source (used for both
	 *  Timeline emissions and TimelineReset). */
	acceptsTimelineSet(set: EventTimelineSet | undefined): boolean;
	/** Whether a RoomEvent.Timeline emission belongs to this source
	 *  (which timeline set produced it). */
	acceptsTimeline(data: {
		timeline?: import("matrix-js-sdk").EventTimeline;
	}): boolean;
	/** Whether an event belongs to this source by its own shape - the
	 *  per-event backstop used where no emission data exists. */
	acceptsEvent(event: MatrixEvent): boolean;
}

/** The room's main timeline: current behavior, the default source. */
export function mainTimelineSource(): TimelineSource {
	return {
		key: "main",
		inThread: false,
		getTimelineSet: (room) => room.getUnfilteredTimelineSet(),
		acceptsTimelineSet: (set) => !set?.thread,
		acceptsTimeline: (data) => !isThreadTimelineData(data),
		acceptsEvent: (event) => !isThreadReply(event),
	};
}

/** One thread's timeline. The caller (ThreadPanel via ensureThread)
 *  guarantees the Thread object exists before the hook loads. */
export function threadTimelineSource(threadId: string): TimelineSource {
	const acceptsTimelineSet = (set: EventTimelineSet | undefined): boolean =>
		set?.thread?.id === threadId;
	return {
		key: `thread:${threadId}`,
		inThread: true,
		getTimelineSet: (room) => room.getThread(threadId)?.timelineSet ?? null,
		acceptsTimelineSet,
		acceptsTimeline: (data) =>
			acceptsTimelineSet(data.timeline?.getTimelineSet()),
		// The root itself plus anything belonging to this thread. Relations
		// (reactions/edits) targeting thread events carry no m.thread on
		// the wire but DO get threadRootId once attached; fall back to it.
		acceptsEvent: (event) =>
			event.getId() === threadId || event.threadRootId === threadId,
	};
}
