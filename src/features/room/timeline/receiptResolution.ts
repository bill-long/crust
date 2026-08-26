import type { MatrixEvent } from "matrix-js-sdk";

/**
 * Resolves read receipts to the rows they should mark.
 *
 * A receipt can point at an event the timeline never renders - an edit, a
 * reaction, a redaction - because clients send receipts for whatever event
 * they last processed, not for whatever they last drew. Resolving means
 * walking backwards through the raw window to the nearest event that *is*
 * displayable, which is the row the user actually read up to.
 *
 * Built once per window rather than exposed as a bare function: the "read by"
 * avatars resolve one receipt per room member, and re-scanning the window
 * (up to 2000 events) for each of them on every receipt tick is main-thread
 * work measured in millions of comparisons.
 *
 * Both consumers - the "read by" avatars and the unread divider - construct
 * this from the same displayable set, so they cannot disagree about where a
 * given receipt lands.
 *
 * @param windowEvents - the raw SDK window, oldest first
 * @param isDisplayable - membership test for the rendered rows
 */
export function createReceiptResolver(
	windowEvents: readonly MatrixEvent[],
	isDisplayable: (eventId: string) => boolean,
): (receiptEventId: string) => string | null {
	let indexById: Map<string, number> | null = null;

	return (receiptEventId: string): string | null => {
		if (isDisplayable(receiptEventId)) return receiptEventId;

		// Built lazily: receipts that already point at a drawn row - the
		// common case - never need it.
		if (!indexById) {
			indexById = new Map();
			for (let i = 0; i < windowEvents.length; i++) {
				const id = windowEvents[i].getId();
				if (id !== undefined) indexById.set(id, i);
			}
		}

		const start = indexById.get(receiptEventId);
		if (start === undefined) return null;

		for (let i = start; i >= 0; i--) {
			const id = windowEvents[i].getId();
			if (id && isDisplayable(id)) return id;
		}
		return null;
	};
}
