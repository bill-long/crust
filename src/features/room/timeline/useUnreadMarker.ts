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
 * The read receipt this derives from is a *snapshot*, taken when the timeline
 * scope changes rather than read live. That is the whole point: opening a room
 * immediately sends a receipt for the newest event (`useReadReceipts`), so a
 * live read would erase the boundary in the same frame the user arrived to
 * look at it. Snapshotting keeps the divider where the user left off for as
 * long as they stay - the same way Discord holds its divider until you leave
 * the channel and come back.
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
	// Latched per scope rather than computed per read. The latch is what
	// makes this a snapshot; the retry is because the scope may not exist yet
	// when this first runs - a thread's `Thread` object in particular is
	// created lazily. Without it, one unlucky mount would disable the divider
	// for the whole visit, and the room subtree is keyed, so nothing would
	// ever re-mount to fix it.
	let capturedRoomId: string | null = null;
	let capturedThreadId: string | undefined;
	const readUpToId = createMemo<string | null>((prev) => {
		const currentRoomId = roomId();
		const currentThreadId = thread()?.threadId;
		if (
			capturedRoomId === currentRoomId &&
			capturedThreadId === currentThreadId
		)
			return prev ?? null;

		// The scope changed, so the previous snapshot is not ours to keep:
		// holding it would place this room's divider from another room's
		// receipt while we wait for the store to catch up.
		capturedRoomId = null;
		capturedThreadId = undefined;

		// `.length`, not the accessor alone: `events` is a Solid store proxy,
		// and reading it without touching a property fires no get-trap and
		// tracks nothing. This is the retry trigger - rows arriving means the
		// room is in the store, which is when a scope that was missing turns up.
		deps.events().length;

		const room = client.getRoom(currentRoomId);
		const myUserId = client.getUserId();
		if (!room || !myUserId) return null;
		const scope = currentThreadId ? room.getThread(currentThreadId) : room;
		if (!scope) return null;

		capturedRoomId = currentRoomId;
		capturedThreadId = currentThreadId;
		return scope.getEventReadUpTo(myUserId) ?? null;
	});

	/**
	 * The receipt resolved onto a row we actually draw. Reading a message
	 * from another client can leave the receipt on an edit or a reaction,
	 * which this timeline never renders; without the walk-back the boundary
	 * would silently vanish even though it sits well inside the window.
	 */
	const resolvedReadUpToId = createMemo(() => {
		const receiptId = readUpToId();
		if (!receiptId) return null;
		const rows = deps.events();

		// Fast path for the overwhelmingly common case. This memo re-runs on
		// every per-row mutation - a reaction, an edit, a local echo settling
		// - and building the id set plus copying the whole SDK window each
		// time is work the walk-back rarely needs.
		const row = rows.find((ev) => ev.eventId === receiptId);
		if (row && !row.stateNotice) return receiptId;
		// Not drawn (or drawn only as a notice): fall through to the
		// walk-back, which is what finds the row it really marks.

		const displayable = displayableIds(rows);
		const resolve = createReceiptResolver(deps.getWindowEvents(), (id) =>
			displayable.has(id),
		);
		return resolve(receiptId);
	});

	const firstUnreadEventId = createMemo(() => {
		const myUserId = client.getUserId();
		if (!myUserId) return null;
		const rows = deps.events();
		const index = firstUnreadIndex(rows, resolvedReadUpToId(), myUserId);
		return index === -1 ? null : rows[index].eventId;
	});

	return { firstUnreadEventId };
}
