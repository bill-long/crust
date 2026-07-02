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
 * - Gate S (shape): true only for events whose WIRE relation is
 *   `m.thread` - the one shape the SDK partitions thread-only. It must
 *   NOT key on `event.threadRootId`/`getThread()`: the SDK deliberately
 *   DUAL-HOMES some events into both the room and the thread (a plain
 *   `m.in_reply_to` reply to a thread root inherits the root's
 *   both-timelines placement via `eventShouldLiveIn`'s parent recursion)
 *   and attaches `.thread` to them - those are main-timeline citizens
 *   and must keep rendering/notifying. Verified E2E: a threadRootId-based
 *   gate wrongly hid replies-to-roots from the main timeline.
 *
 * - Gate T (timeline identity): classifies the EMISSION by which timeline
 *   set produced it. Catches what shape can't: reactions/edits targeting
 *   thread events carry `m.annotation`/`m.replace` on the wire (not
 *   `m.thread`), but they always arrive via the thread's timeline set.
 */

/** Gate S: true when the event is a thread reply on the wire (MSC3440
 *  `rel_type: m.thread`, or its pre-stable `io.element.thread` name).
 *  False for thread roots, plain replies (including replies to a thread
 *  root, which the SDK dual-homes into the main timeline), and state
 *  events. Reads wire content like the SDK's own `threadRootId` getter,
 *  so it works on encrypted events too (thread relations stay cleartext). */
export function isThreadReply(event: MatrixEvent): boolean {
	const content = event.getWireContent?.() ?? event.getContent();
	const relType = (
		content?.["m.relates_to"] as { rel_type?: string } | undefined
	)?.rel_type;
	return relType === "m.thread" || relType === "io.element.thread";
}

/** Gate T: true when a `RoomEvent.Timeline` emission came from a THREAD
 *  timeline set rather than a room one. `data.timeline` is present on every
 *  timeline emission (IRoomTimelineData). */
export function isThreadTimelineData(data: {
	timeline?: EventTimeline;
}): boolean {
	return !!data.timeline?.getTimelineSet().thread;
}
