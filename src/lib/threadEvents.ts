import type { EventTimeline, MatrixEvent } from "matrix-js-sdk";

/**
 * Fail-closed gates that keep thread replies out of main-timeline surfaces
 * (timeline rows, room previews, notifications, search).
 *
 * With `threadSupport: true` the SDK already partitions thread replies out
 * of every ROOM timeline set (`Room.eventShouldLiveIn`), so windows over the
 * unfiltered set never contain them. These gates are still load-bearing:
 * `RoomEvent.Timeline` re-fires for THREAD timelines (each Thread's
 * timelineSet re-emits through the room and client), so every listener that
 * reacts to timeline emissions sees thread traffic and must ignore it.
 *
 * Two complementary gates, applied together where both signals exist:
 *
 * - Gate S (shape): classifies the EVENT by its own thread membership.
 *   Safe for everything that must keep working: plain `m.in_reply_to`
 *   replies have no `threadRootId`, thread ROOTS are excluded via
 *   `isThreadRoot`, and state events return undefined from `threadRootId`.
 *
 * - Gate T (timeline identity): classifies the EMISSION by which timeline
 *   set produced it. Catches what shape can't: reactions/edits targeting
 *   thread events carry `m.annotation`/`m.replace` on the wire (not
 *   `m.thread`) and only gain a `.thread` back-reference after the SDK
 *   attaches them, but they always arrive via the thread's timeline set.
 */

/** Gate S: true when the event lives inside a thread (is a thread reply or
 *  a relation attached to one), false for thread roots, plain replies,
 *  state events, and everything else main-timeline. */
export function isThreadReply(event: MatrixEvent): boolean {
	return event.threadRootId !== undefined && !event.isThreadRoot;
}

/** Gate T: true when a `RoomEvent.Timeline` emission came from a THREAD
 *  timeline set rather than a room one. `data.timeline` is present on every
 *  timeline emission (IRoomTimelineData). */
export function isThreadTimelineData(data: {
	timeline?: EventTimeline;
}): boolean {
	return !!data.timeline?.getTimelineSet().thread;
}
