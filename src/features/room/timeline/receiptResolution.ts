import type { MatrixEvent } from "matrix-js-sdk";

/**
 * Resolve a read receipt to the row it should mark.
 *
 * A receipt can point at an event the timeline never renders - an edit, a
 * reaction, a redaction - because clients send receipts for whatever event
 * they last processed, not for whatever they last drew. Resolving means
 * walking backwards through the raw window to the nearest event that *is*
 * displayable, which is the row the user actually read up to.
 *
 * Shared by the two consumers of that rule so they cannot drift: the
 * "read by" avatars (other people's receipts) and the unread divider (our
 * own). Returns null when nothing can be resolved - the receipt is outside
 * the loaded window, or every event back to its start is non-displayable.
 *
 * @param receiptEventId - the event the receipt points at
 * @param isDisplayable - membership test for the rendered rows
 * @param windowEvents - the raw SDK window, oldest first
 */
export function resolveReceiptToDisplayable(
	receiptEventId: string,
	isDisplayable: (eventId: string) => boolean,
	windowEvents: readonly MatrixEvent[],
): string | null {
	if (isDisplayable(receiptEventId)) return receiptEventId;

	const start = windowEvents.findIndex((ev) => ev.getId() === receiptEventId);
	if (start === -1) return null;

	for (let i = start; i >= 0; i--) {
		const id = windowEvents[i].getId();
		if (id && isDisplayable(id)) return id;
	}
	return null;
}
