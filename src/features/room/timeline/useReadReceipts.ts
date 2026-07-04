import type { MatrixClient, MatrixEvent } from "matrix-js-sdk";
import { ReceiptType, RoomEvent } from "matrix-js-sdk";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import type { TimelineEvent } from "./timelineTypes";

interface ReadReceiptEntry {
	userId: string;
	displayName: string;
}

interface ReadReceiptDeps {
	events: TimelineEvent[];
	getWindowEvents: () => MatrixEvent[];
	getSourceEvent: (eventId: string) => MatrixEvent | undefined;
	atBottom: Accessor<boolean>;
	canLoadNewer: Accessor<boolean>;
	/** The local user's ID, supplied by the caller so receipt self-exclusion
	 *  uses the same value as the rest of the timeline's own-message logic. */
	myUserId: string;
}

/**
 * Read-receipt tracking for the timeline. Builds a map of eventId -> the users
 * who have read up to that event (excluding the local user), and sends the
 * local user's own read receipt for the latest event whenever they are at the
 * live bottom.
 *
 * `roomId` / `thread` are read live, and `atBottom` / `canLoadNewer` are the
 * caller's scroll-state accessors, so the logic always reflects the current
 * scope and position. The RoomEvent.Receipt listener and the four
 * send-triggering effects register under the caller's reactive owner and are
 * cleaned up with it.
 */
export function useReadReceipts(
	client: MatrixClient,
	roomId: Accessor<string>,
	thread: Accessor<{ threadId: string } | undefined>,
	deps: ReadReceiptDeps,
): { receipts: Accessor<Record<string, ReadReceiptEntry[]>> } {
	// Re-trigger read receipt computation on receipt events for the current room.
	const [receiptTick, setReceiptTick] = createSignal(0);
	function onReceiptEvent(_event: unknown, room: { roomId: string }): void {
		if (room.roomId === roomId()) {
			setReceiptTick((n) => n + 1);
		}
	}
	client.on(RoomEvent.Receipt, onReceiptEvent);
	onCleanup(() => client.off(RoomEvent.Receipt, onReceiptEvent));

	// Build a map: eventId -> list of users who have read up to that event
	const receipts = createMemo(() => {
		receiptTick(); // track receipt updates for reactivity
		const map = Object.create(null) as Record<string, ReadReceiptEntry[]>;
		const room = client.getRoom(roomId());
		if (!room) return map;

		// Build a set of displayable event IDs for quick lookup.
		// State-notice events (joins/leaves/name changes) are excluded so
		// receipts targeting them fall through to the nearest prior
		// message via the walk-backwards path below - otherwise the
		// "read by …" avatars would intermittently disappear whenever
		// membership churns.
		const displayableIds = new Set<string>();
		for (const ev of deps.events) {
			if (ev.stateNotice) continue;
			displayableIds.add(ev.eventId);
		}

		const timelineEvents = deps.getWindowEvents();
		// Precompute eventId->index map for O(1) lookup
		const idxById = Object.create(null) as Record<string, number>;
		for (let i = 0; i < timelineEvents.length; i++) {
			const id = timelineEvents[i].getId();
			if (id) idxById[id] = i;
		}

		const members = room.getMembers();
		for (const member of members) {
			if (member.userId === deps.myUserId) continue;
			let readUpToId = room.getEventReadUpTo(member.userId);
			if (!readUpToId) continue;

			// If the receipt points at a non-displayable event (e.g. an edit),
			// walk backwards through the SDK timeline to find the nearest
			// displayable event
			if (!displayableIds.has(readUpToId)) {
				const idx = idxById[readUpToId];
				if (idx === undefined) continue;
				let resolved: string | null = null;
				for (let i = idx; i >= 0; i--) {
					const id = timelineEvents[i].getId();
					if (id && displayableIds.has(id)) {
						resolved = id;
						break;
					}
				}
				if (!resolved) continue;
				readUpToId = resolved;
			}

			if (!map[readUpToId]) map[readUpToId] = [];
			map[readUpToId].push({
				userId: member.userId,
				displayName: member.name?.trim() || member.userId,
			});
		}
		// Sort each per-event receipt list by userId for stable ordering.
		// Per-event lists are typically <10 entries, so this is far cheaper
		// than sorting the full room member list (which can be 1000s) on
		// every receipt tick.
		for (const id in map) {
			map[id].sort((a, b) => a.userId.localeCompare(b.userId));
		}
		return map;
	});

	// Send read receipt for the latest event when at bottom
	let lastSentReceiptEventId: string | null = null;

	function sendReadReceipt(): void {
		if (!deps.atBottom()) return;
		// Don't send receipts for events the user hasn't scrolled to.
		// When behind live, forward pagination appends events but
		// auto-scroll is suppressed, so atBottom can be stale-true.
		if (deps.canLoadNewer()) return;
		const lastEvent = deps.events[deps.events.length - 1];
		if (!lastEvent || lastEvent.eventId === lastSentReceiptEventId) return;
		const eventId = lastEvent.eventId;
		// Skip local echo events - their temporary ~-prefixed IDs
		// are rejected by the server with 400.
		if (!eventId.startsWith("$")) return;
		const matrixEvent = deps.getSourceEvent(eventId);
		if (!matrixEvent) return;
		client
			// Main timeline: UNTHREADED (3rd arg true) - a plain receipt would
			// get thread_id "main" and clear only main-timeline counts, leaving
			// the per-thread counts the room badge sums un-clearable outside
			// the panel. Unthreaded preserves the pre-thread invariant that
			// reading a room clears its whole badge.
			// Thread panel: THREADED (3rd arg false) - the SDK derives
			// thread_id from the event, so reading a thread clears exactly that
			// thread's counts and never the whole room's read state.
			.sendReadReceipt(matrixEvent, ReceiptType.Read, !thread())
			.then(() => {
				lastSentReceiptEventId = eventId;
			})
			.catch(() => {
				// Best-effort; receipt will retry on next scroll/event
			});
	}

	// Send receipt when new events arrive or last event ID changes
	// (local echo replacement triggers the ID change without a length change)
	createEffect(
		on(
			() => deps.events[deps.events.length - 1]?.eventId,
			() => sendReadReceipt(),
		),
	);

	// Send receipt when user scrolls to bottom
	createEffect(
		on(deps.atBottom, (isAtBottom) => {
			if (isAtBottom) sendReadReceipt();
		}),
	);

	// Send receipt when forward pagination catches up to live.
	// The events.length effect misses the final page because
	// canLoadNewer is still true when events rebuild.
	createEffect(
		on(deps.canLoadNewer, (hasNewer) => {
			if (!hasNewer) sendReadReceipt();
		}),
	);

	// Send receipt when room first opens
	createEffect(
		on(roomId, () => {
			lastSentReceiptEventId = null;
			// Defer so events are loaded first
			requestAnimationFrame(() => sendReadReceipt());
		}),
	);

	return { receipts };
}
