import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { type Accessor, createMemo } from "solid-js";
import { createReceiptResolver } from "./receiptResolution";
import type { TimelineEvent } from "./timelineTypes";
import { firstUnreadIndex } from "./unreadMarker";

export interface UnreadMarker {
	/**
	 * The row the "New messages" divider goes above, and the row the jump
	 * affordance lands on. Null when there is nothing unread, or when the
	 * boundary is not in the loaded window.
	 *
	 * That second case - more than a window's worth arrived since the last
	 * read - is a deliberate gap rather than an oversight. Placing the
	 * boundary needs the receipt to be *in* the window, and every signal
	 * available for guessing at it from outside is wrong in an ordinary
	 * situation: the receipt's send time misreads a partial catch-up in
	 * another client, and the forward-pagination flag misreads a window whose
	 * far end the SDK trimmed during deep scrollback. Offering nothing is
	 * honest; offering a jump into a room the user has already read is not.
	 */
	firstUnreadEventId: Accessor<string | null>;
}

interface UnreadMarkerDeps {
	events: Accessor<readonly TimelineEvent[]>;
	/** Raw SDK window, for resolving a receipt that points at a row we never draw. */
	getWindowEvents: () => MatrixEvent[];
}

/**
 * Rows the timeline draws. Matches `useReadReceipts`: state notices are
 * excluded, so a receipt landing on a join or a topic change resolves back to
 * the nearest real message rather than to the notice. Both surfaces build
 * their resolver from this, so they cannot land the same receipt in two
 * different places.
 */
function displayableIds(events: readonly TimelineEvent[]): Set<string> {
	const ids = new Set<string>();
	for (const ev of events) {
		if (ev.stateNotice) continue;
		ids.add(ev.eventId);
	}
	return ids;
}

/**
 * Where the "New messages" divider goes.
 *
 * Decided once per timeline scope, from the read receipt as it stood when the
 * user arrived, and then frozen. Both halves of that matter:
 *
 * Reading the receipt live would erase the boundary in the same frame the
 * user arrived to look at it, because opening a room immediately sends a
 * receipt for the newest event (`useReadReceipts`).
 *
 * Re-deriving the boundary from a live event list would do the opposite,
 * and worse: with the snapshot pinned behind the newest event, every message
 * that arrived while the user sat watching the live end would look unread and
 * pull a red divider in above itself. Freezing means the divider marks where
 * the user actually left off and stays there, the way Discord holds its
 * divider until you leave the channel and come back.
 *
 * `Room` and `Thread` both extend the SDK's `ReadReceipt`, so the thread panel
 * gets its own boundary from its own receipt with no special-casing here.
 */
export function useUnreadMarker(
	client: MatrixClient,
	roomId: Accessor<string>,
	thread: Accessor<{ threadId: string } | undefined>,
	deps: UnreadMarkerDeps,
): UnreadMarker {
	let scopeRoomId: string | null = null;
	let scopeThreadId: string | undefined;
	let decided = false;

	const firstUnreadEventId = createMemo<string | null>((prev) => {
		const currentRoomId = roomId();
		const currentThreadId = thread()?.threadId;

		if (scopeRoomId !== currentRoomId || scopeThreadId !== currentThreadId) {
			scopeRoomId = currentRoomId;
			scopeThreadId = currentThreadId;
			decided = false;
		} else if (decided) {
			// Frozen for this scope. Nothing that arrives later can move the
			// boundary, and nothing that arrives later is unread - the user
			// is here reading it.
			return prev ?? null;
		}

		// Everything below is the one-shot attempt. It keeps retrying, driven
		// by the rows it reads, until it has a scope and a receipt to work
		// from - a room can be absent from the store on a cold open, and a
		// thread's `Thread` object is created lazily. Without the retry a
		// single unlucky first evaluation would disable the divider for the
		// whole visit, since the room subtree is keyed and never re-mounts.
		const rows = deps.events();
		if (rows.length === 0) return null;

		const myUserId = client.getUserId();
		const room = client.getRoom(currentRoomId);
		if (!room || !myUserId) return null;
		const scope = currentThreadId ? room.getThread(currentThreadId) : room;
		if (!scope) return null;

		const receiptId = scope.getEventReadUpTo(myUserId);
		// No receipt yet is not the same as nothing unread: the room can
		// arrive in sync before its `m.receipt` ephemeral is applied. Keep
		// retrying rather than freezing the feature off for the visit.
		if (!receiptId) return null;

		decided = true;

		// A receipt can point at a row this timeline never draws - an edit, a
		// reaction, a state notice - so walk back to the one it really marks.
		// The fast path covers the common case without building the id set or
		// copying the SDK window; both only happen on this single evaluation
		// either way.
		const onRow = rows.find((ev) => ev.eventId === receiptId);
		let resolved: string | null;
		if (onRow && !onRow.stateNotice) {
			resolved = receiptId;
		} else {
			const displayable = displayableIds(rows);
			resolved = createReceiptResolver(deps.getWindowEvents(), (id) =>
				displayable.has(id),
			)(receiptId);
		}

		const index = firstUnreadIndex(rows, resolved, myUserId);
		return index === -1 ? null : rows[index].eventId;
	});

	return { firstUnreadEventId };
}
