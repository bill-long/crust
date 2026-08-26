import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { RoomEvent } from "matrix-js-sdk";
import { type Accessor, createMemo, createSignal, onCleanup } from "solid-js";
import { createReceiptResolver } from "./receiptResolution";
import type { TimelineEvent } from "./timelineTypes";
import { firstUnreadIndex } from "./unreadMarker";

export interface UnreadMarker {
	/**
	 * The row the "New messages" divider goes above, and the row the jump
	 * affordance lands on. Null when nothing was unread on arrival, or while
	 * the boundary cannot yet be placed.
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
 * Two things are captured, at different moments, and conflating them is the
 * mistake this shape exists to avoid.
 *
 * The **receipt** is taken as early as it can be read, because opening a room
 * immediately sends a receipt for the newest event (`useReadReceipts`) - wait
 * any longer and the boundary is gone before the user has looked at it.
 *
 * The **placement** is taken as soon as that receipt can be resolved onto a
 * loaded row, and only then is it frozen. Freezing earlier would strand the
 * feature: a receipt further back than the initial window resolves to
 * nothing, and the divider must still appear when back-pagination reaches it.
 * Freezing later - re-deriving from a live event list - is worse: with the
 * receipt pinned behind the newest event, every message arriving while the
 * user sat watching the live end would look unread and pull a red divider in
 * above itself.
 *
 * The result is that the divider marks where the user actually left off and
 * stays there, the way Discord holds its divider until you leave the channel
 * and come back.
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
	// A receipt arrives as an ephemeral in `/sync` and touches no timeline
	// event, so in a quiet room nothing else would ever re-run the capture
	// below. Same seam `useReadReceipts` uses.
	const [receiptTick, setReceiptTick] = createSignal(0);
	const onReceipt = (_event: unknown, room: { roomId: string }): void => {
		if (room.roomId === roomId()) setReceiptTick((n) => n + 1);
	};
	client.on(RoomEvent.Receipt, onReceipt);
	onCleanup(() => client.off(RoomEvent.Receipt, onReceipt));

	// One generation per timeline scope, so both captures below reset
	// together and neither can carry the previous room's answer forward.
	let lastRoomId: string | null = null;
	let lastThreadId: string | undefined;
	let generation = 0;
	const scope = createMemo(() => {
		const currentRoomId = roomId();
		const currentThreadId = thread()?.threadId;
		if (currentRoomId !== lastRoomId || currentThreadId !== lastThreadId) {
			lastRoomId = currentRoomId;
			lastThreadId = currentThreadId;
			generation++;
		}
		return { roomId: currentRoomId, threadId: currentThreadId, generation };
	});

	// Capture 1: the receipt, as early as it can be read.
	let receiptGeneration = -1;
	let capturedReceipt: string | null = null;
	const readUpToId = createMemo(() => {
		const { roomId: currentRoomId, threadId, generation: gen } = scope();
		if (receiptGeneration === gen) return capturedReceipt;

		// Retry triggers. A room can be absent from the store on a cold open
		// and a thread's `Thread` object is created lazily, so the first
		// evaluation often has nothing to read.
		receiptTick();
		deps.events().length;

		const myUserId = client.getUserId();
		const room = client.getRoom(currentRoomId);
		if (!room || !myUserId) return null;
		const target = threadId ? room.getThread(threadId) : room;
		if (!target) return null;
		const receiptId = target.getEventReadUpTo(myUserId);
		if (!receiptId) return null;

		receiptGeneration = gen;
		capturedReceipt = receiptId;
		return receiptId;
	});

	// Capture 2: the placement, frozen once the receipt lands on a real row.
	let placementGeneration = -1;
	let placedBoundary: string | null = null;
	const firstUnreadEventId = createMemo(() => {
		const { generation: gen } = scope();
		if (placementGeneration === gen) return placedBoundary;

		const receiptId = readUpToId();
		if (!receiptId) return null;
		const myUserId = client.getUserId();
		if (!myUserId) return null;
		const rows = deps.events();
		if (rows.length === 0) return null;

		// A receipt can point at a row this timeline never draws - an edit, a
		// reaction, a state notice - so walk back to the one it really marks.
		// The fast path covers the common case without building the id set or
		// copying the SDK window; neither happens more than once per scope.
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
		// Not in this window yet. Leave it undecided: back-pagination may
		// still bring it in, and this is the case - more unread than one
		// window - where the user most needs the boundary.
		if (!resolved) return null;

		placementGeneration = gen;
		const index = firstUnreadIndex(rows, resolved, myUserId);
		placedBoundary = index === -1 ? null : rows[index].eventId;
		return placedBoundary;
	});

	return { firstUnreadEventId };
}
