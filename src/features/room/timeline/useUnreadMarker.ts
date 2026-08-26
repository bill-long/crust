import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { type Accessor, createMemo } from "solid-js";
import { createReceiptResolver } from "./receiptResolution";
import type { TimelineEvent } from "./timelineTypes";
import { firstUnreadIndex } from "./unreadMarker";

export interface UnreadMarker {
	/**
	 * The row the "New messages" divider goes above, or null when the
	 * boundary is not in the loaded window (or there is nothing unread).
	 */
	firstUnreadEventId: Accessor<string | null>;
	/**
	 * Where "jump to where I left off" should land, or null when there is
	 * nowhere to go. Falls back to the read receipt itself when the boundary
	 * has been paginated out of the window: the divider cannot be drawn from
	 * there, but `jumpToEvent` can still load that context, which is exactly
	 * the case the user most needs help with.
	 */
	jumpTargetEventId: Accessor<string | null>;
}

interface UnreadMarkerDeps {
	events: Accessor<readonly TimelineEvent[]>;
	/** Raw SDK window, for resolving a receipt that points at a row we never draw. */
	getWindowEvents: () => MatrixEvent[];
}

/** Our own receipt, snapshotted: which event, and when we sent it. */
interface ReceiptSnapshot {
	eventId: string;
	/** Send time of the receipt, or null when the server did not give one. */
	ts: number | null;
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
 * Where the "New messages" divider goes, and where the jump affordance
 * should take the user.
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
	const receipt = createMemo<ReceiptSnapshot | null>((prev) => {
		const currentRoomId = roomId();
		const currentThreadId = thread()?.threadId;
		if (
			capturedRoomId === currentRoomId &&
			capturedThreadId === currentThreadId
		)
			return prev ?? null;

		// `.length`, not the accessor alone: `events` is a Solid store proxy,
		// and reading it without touching a property fires no get-trap and
		// tracks nothing. This is the retry trigger - rows arriving means the
		// room is in the store, which is when a scope that was missing turns up.
		deps.events().length;

		const room = client.getRoom(currentRoomId);
		const myUserId = client.getUserId();
		if (!room || !myUserId) return prev ?? null;
		const scope = currentThreadId ? room.getThread(currentThreadId) : room;
		if (!scope) return prev ?? null;

		capturedRoomId = currentRoomId;
		capturedThreadId = currentThreadId;

		// The wrapped receipt carries the send time, which is what tells a
		// genuine backlog apart from a trimmed window (see jumpTargetEventId).
		// `getEventReadUpTo` is the fallback because it also considers private
		// receipts, so it can know an id the wrapped read receipt does not.
		const wrapped = scope.getReadReceiptForUserId(myUserId);
		const eventId = wrapped?.eventId ?? scope.getEventReadUpTo(myUserId);
		if (!eventId) return null;
		const ts = wrapped?.eventId === eventId ? (wrapped.data?.ts ?? null) : null;
		return { eventId, ts };
	});

	const readUpToId = createMemo(() => receipt()?.eventId ?? null);

	/**
	 * The receipt resolved onto a row we actually draw. Reading a message
	 * from another client can leave the receipt on an edit or a reaction,
	 * which this timeline never renders; without the walk-back the boundary
	 * would silently vanish even though it sits well inside the window.
	 */
	const resolvedReadUpToId = createMemo(() => {
		const receiptId = readUpToId();
		if (!receiptId) return null;
		const displayable = displayableIds(deps.events());
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

	const jumpTargetEventId = createMemo(() => {
		const inWindow = firstUnreadEventId();
		if (inWindow) return inWindow;

		// Nothing to draw, but there may still be somewhere to go. Offering
		// it turns on telling a genuine backlog - the boundary is older than
		// everything loaded - apart from a window that simply does not reach
		// it, which is what deep back-pagination produces in a room that is
		// fully read. The receipt's send time answers that: we sent it when
		// we last read, so a receipt newer than the oldest loaded row means
		// the window is behind us, not ahead.
		const snapshot = receipt();
		if (!snapshot) return null;
		if (resolvedReadUpToId()) return null;
		const rows = deps.events();
		if (rows.length === 0) return null;
		// No timestamp means no way to tell the two apart; withhold rather
		// than point the user at a room they have already read.
		if (snapshot.ts === null) return null;
		if (snapshot.ts >= rows[0].timestamp) return null;
		return snapshot.eventId;
	});

	return { firstUnreadEventId, jumpTargetEventId };
}
