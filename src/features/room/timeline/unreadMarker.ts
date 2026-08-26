import type { TimelineEvent } from "./timelineTypes";

/**
 * Index of the row the "New messages" divider belongs above, or -1 when there
 * is nothing to mark.
 *
 * `readUpToId` is our own read receipt, snapshotted when the timeline scope
 * opened (see `useUnreadMarker`) so the divider holds still while the user
 * reads rather than sliding down as receipts go out.
 *
 * Two kinds of row are skipped when looking for the first unread. Our own
 * messages, because nothing we sent is news to us - a divider above them
 * reads as "you have not seen your own message". And state notices, because
 * a join or a topic change is not what the user came back to catch up on;
 * the divider should land on the first thing someone actually said.
 *
 * Returns -1 when the receipt is missing (nothing read yet, so there is no
 * boundary to draw) or points outside the loaded window (the divider cannot
 * be placed; the jump affordance is what gets the user there).
 */
export function firstUnreadIndex(
	events: readonly TimelineEvent[],
	readUpToId: string | null,
	myUserId: string,
): number {
	if (!readUpToId) return -1;

	const readIndex = events.findIndex((ev) => ev.eventId === readUpToId);
	if (readIndex === -1) return -1;

	for (let i = readIndex + 1; i < events.length; i++) {
		const ev = events[i];
		if (ev.senderId === myUserId) continue;
		if (ev.stateNotice) continue;
		return i;
	}
	return -1;
}
