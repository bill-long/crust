import type { EventTimeline, MatrixEvent } from "matrix-js-sdk";
import { THREAD_RELATION_TYPE } from "matrix-js-sdk";

/**
 * Gates that keep thread replies out of main-timeline surfaces (timeline
 * rows, room previews, notifications). Surfaces that DO list them (search
 * hits, pinned messages) use {@link threadJumpTarget} to route a jump to
 * the thread panel instead. Safety direction: when a
 * signal is missing or ambiguous the gates err toward KEEPING an event
 * visible - hiding a real message is worse than briefly showing a thread
 * reply, and the SDK's own timeline partition is the primary defense.
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
 * - Gate S (shape): mirrors the SDK's own partition predicate EXACTLY -
 *   `event.isRelation(THREAD_RELATION_TYPE.name)`, the same call
 *   `eventShouldLiveIn` keys on. Anything looser or tighter desyncs from
 *   the partition and hides events the SDK left in the room timeline:
 *   - NOT `event.threadRootId`/`getThread()`: the SDK deliberately
 *     DUAL-HOMES some events into both the room and the thread (a plain
 *     `m.in_reply_to` reply to a thread root inherits the root's
 *     both-timelines placement via parent recursion) and attaches
 *     `.thread` to them - verified E2E: a threadRootId-based gate hid
 *     replies-to-roots from the main timeline.
 *   - NOT a hardcoded name list: `THREAD_RELATION_TYPE.name` is server-
 *     latched (stable `m.thread`, pre-stable `io.element.thread`), and
 *     the SDK partitions on exactly ONE name at a time - an event
 *     carrying the other name stays in the room timeline and must
 *     keep rendering.
 *   `isRelation` also reads WIRE content (thread relations stay cleartext
 *   on encrypted events) and excludes state events, matching the SDK.
 *
 * - Gate T (timeline identity): classifies the EMISSION by which timeline
 *   set produced it. Catches what shape can't: reactions/edits targeting
 *   thread events carry `m.annotation`/`m.replace` on the wire (not
 *   `m.thread`), and a dual-homed thread ROOT re-emits from the thread's
 *   timeline as well - both always arrive via the thread's timeline set.
 */

/** Gate S: true when the event is a thread reply on the wire - the exact
 *  shape the SDK partitions thread-only. False for thread roots, plain
 *  replies (including replies to a thread root, which the SDK dual-homes
 *  into the main timeline), state events, and everything else. The
 *  optional call is defensive against partial event fakes (matching the
 *  `localRedactionEvent` check in isDisplayable); a missing method reads
 *  as "not a thread reply", the fail-open direction that keeps messages
 *  visible. */
export function isThreadReply(event: MatrixEvent): boolean {
	return event.isRelation?.(THREAD_RELATION_TYPE.name) ?? false;
}

/** Gate T: true when a `RoomEvent.Timeline` emission came from a THREAD
 *  timeline set rather than a room one. Accepts `IRoomTimelineData`
 *  structurally; `timeline` is optional here (and null-guarded) so mock
 *  emissions without it fail safe to "not a thread". */
export function isThreadTimelineData(data: {
	timeline?: EventTimeline;
}): boolean {
	return !!data.timeline?.getTimelineSet().thread;
}

/** Where a jump to `event` must land: the id of the thread ROOT whose
 *  panel shows the event, or undefined when the event lives in the main
 *  timeline (jump there as usual). Only wire-shape thread replies
 *  (Gate S) route to a panel - thread roots and plain replies to a root
 *  are dual-homed into the main timeline and jump there. The self-guard
 *  drops a malformed event that relates to itself, which would otherwise
 *  open a panel "rooted" on the reply. */
export function threadJumpTarget(event: MatrixEvent): string | undefined {
	if (!isThreadReply(event)) return undefined;
	const rootId = event.threadRootId;
	if (!rootId || rootId === event.getId()) return undefined;
	return rootId;
}
