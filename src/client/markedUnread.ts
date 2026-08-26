import { EventType, type MatrixClient, type Room } from "matrix-js-sdk";
import { type Accessor, createEffect, untrack } from "solid-js";
import { reportError } from "../lib/reportError";
import { enqueueOwnerKeyedWrite } from "../lib/writeQueue";
import type { RoomSummary, SummariesStore } from "./summaries";

/** Stable account-data type for the marked-unread flag (MSC2867). */
export const MARKED_UNREAD_TYPE = EventType.MarkedUnread;
/**
 * Pre-stabilization type some clients still write; read as a fallback so a
 * flag set elsewhere isn't invisible here. Writes target the stable type,
 * mirrored onto this one only when the room already carries it (see
 * enqueueFlagWrite).
 */
export const MARKED_UNREAD_TYPE_UNSTABLE = "com.famedly.marked_unread";

/**
 * Whether `room` is explicitly marked unread (MSC2867). The stable event
 * wins when it carries a boolean `unread`; otherwise the unstable fallback
 * is consulted. Malformed content reads as false.
 */
export function getRoomMarkedUnread(room: Room): boolean {
	const stable = room.getAccountData(MARKED_UNREAD_TYPE)?.getContent()?.unread;
	if (typeof stable === "boolean") return stable;
	return (
		room.getAccountData(MARKED_UNREAD_TYPE_UNSTABLE)?.getContent()?.unread ===
		true
	);
}

/**
 * Whether "Mark as unread" is currently actionable for `summary`: only for
 * a JOINED room (a room left on another device keeps its entry until sync
 * prunes it, and flagging it would strand account data nothing renders)
 * that shows as fully read and isn't already flagged. "Shows as" matches
 * the row's badge exactly: a muted room's hidden count doesn't block the
 * action - marking it unread is how the user makes a muted room visible.
 * The single gate for every surface that offers the action (the room-list
 * context menu and the room-pane overflow item), so they can't disagree.
 */
export function canMarkRoomUnread(summary: RoomSummary | undefined): boolean {
	return (
		!!summary &&
		summary.membership === "join" &&
		!summary.markedUnread &&
		(summary.unreadCount === 0 || summary.isMuted)
	);
}

/**
 * The slice of `ClientContextValue` the marked-unread actions need. Both
 * actions are optimistic-first: the summary flag flips immediately and the
 * account-data write confirms (or rolls back) afterwards.
 */
interface MarkedUnreadContext {
	client: MatrixClient;
	summaries: SummariesStore;
	optimisticallySetMarkedUnread: (roomId: string, value: boolean) => void;
}

/**
 * Per-room, per-client chains serializing `m.marked_unread` writes. Mark
 * and clear PUT opposite values to the same key on independent requests,
 * so an ordinary mark-then-open sequence could otherwise commit out of
 * order server-side and leave the flag set for a room the user just
 * opened. Keyed by client (WeakMap) so a logout/login cycle can't chain
 * onto a dead client's writes.
 */
const flagWriteChains = new WeakMap<MatrixClient, Map<string, Promise<void>>>();

function enqueueFlagWrite(
	client: MatrixClient,
	roomId: string,
	unread: boolean,
): Promise<void> {
	return enqueueOwnerKeyedWrite(flagWriteChains, client, roomId, async () => {
		await client.setRoomAccountData(roomId, MARKED_UNREAD_TYPE, { unread });
		// Mirror onto the unstable type when the room carries one: with a
		// stable-only write, the read precedence (stable boolean wins)
		// would permanently mask every future unstable-only mark from a
		// pre-stabilization client - Crust would clear its own view while
		// that client's marks stay invisible forever.
		if (client.getRoom(roomId)?.getAccountData(MARKED_UNREAD_TYPE_UNSTABLE)) {
			const unstableKey = MARKED_UNREAD_TYPE_UNSTABLE as unknown as Parameters<
				MatrixClient["setRoomAccountData"]
			>[1];
			await client.setRoomAccountData(roomId, unstableKey, { unread });
		}
	});
}

/**
 * Failure rollback for an optimistic flag flip: converge the summary to
 * the AUTHORITATIVE SDK account-data value rather than blindly inverting.
 * Inverting can't distinguish "our pending flip" from a same-value sync
 * echo that landed mid-flight (another device's write, or a PUT the
 * server applied even though our response errored) - and clobbering the
 * echo would stick, since /sync never re-delivers unchanged account
 * data. Converging is always safe: if the failed PUT truly changed
 * nothing, the SDK holds the pre-action value (a plain rollback); if the
 * server did apply something, its echo either already updated the SDK or
 * is about to, and onRoomAccountData will land on the same value.
 */
function rollBackToAuthoritative(
	ctx: MarkedUnreadContext,
	roomId: string,
): void {
	const room = ctx.client.getRoom(roomId);
	ctx.optimisticallySetMarkedUnread(
		roomId,
		room ? getRoomMarkedUnread(room) : false,
	);
}

/**
 * Mark `roomId` unread: flip the summary flag so the sidebar dot appears
 * instantly, then persist `m.marked_unread` account data. Rolled back with
 * an error toast if the write fails (the dot is the only feedback surface,
 * so a silent failure would look like success). No-op when already marked.
 */
export function markRoomUnread(ctx: MarkedUnreadContext, roomId: string): void {
	if (ctx.summaries[roomId]?.markedUnread) return;
	ctx.optimisticallySetMarkedUnread(roomId, true);
	enqueueFlagWrite(ctx.client, roomId, true).catch((err) => {
		rollBackToAuthoritative(ctx, roomId);
		reportError(err, {
			userMessage: "Couldn't mark the room as unread.",
			logLabel: "Mark as unread failed",
		});
	});
}

/**
 * Clear the marked-unread flag. Gated on the summary flag - which includes
 * optimistic state - so a room that isn't marked does no account-data
 * write at all. A failed write rolls the flag back on: the PUT changed
 * nothing server-side and /sync only re-delivers account data that
 * changed, so without the rollback this device would show the room read
 * while the server (and every other device) still has it marked - and the
 * gate above would block any retry. With the rollback, the restored dot is
 * the visible feedback and the next open retries the write, so the failure
 * itself stays console-only.
 */
export function clearRoomMarkedUnread(
	ctx: MarkedUnreadContext,
	roomId: string,
): void {
	if (!ctx.summaries[roomId]?.markedUnread) return;
	ctx.optimisticallySetMarkedUnread(roomId, false);
	enqueueFlagWrite(ctx.client, roomId, false).catch((err) => {
		rollBackToAuthoritative(ctx, roomId);
		reportError(err, { logLabel: "Clearing marked-unread failed" });
	});
}

/**
 * The room whose marked-unread flag the CURRENT open has already consumed,
 * per client. Lives outside any component (and is keyed by client, not
 * stored globally, so a logout/login cycle starts clean) because the
 * owning Layout can be re-created mid-view: the latch is what makes a
 * remount with the same room still open not count as a new "open".
 */
const consumedLatch = new WeakMap<MatrixClient, string>();

/**
 * Consume the marked-unread flag when a room is opened (MSC2867: viewing
 * the room clears it - the same open-consumes semantics Element applies).
 *
 * "Open" is a transition of the viewed room id. Consequences, all
 * deliberate:
 * - A flag set while the room is already open (the room-pane overflow
 *   action, a right-click on the open room's row, or another device)
 *   survives until the room is NEXT opened.
 * - Any route transition away from the room - the back-to-list gesture, a
 *   different room, or a full-screen route like settings - ends the
 *   current open, so returning is a new open and consumes.
 *
 * The effect tracks the summary entry's identity (a top-level store key)
 * so a cold-launch restore straight into a marked room still clears once
 * the initial sync creates the entry, but not the `markedUnread` field
 * itself (a field-level store write), so marking the open room can't
 * re-trigger consumption.
 */
export function useMarkedUnreadConsumer(
	ctx: MarkedUnreadContext,
	roomId: Accessor<string | undefined>,
): void {
	createEffect(() => {
		const rid = roomId();
		// A different room (or none) is open now: the previous room's open
		// is over, so drop its latch even if the new room's entry hasn't
		// synced yet - returning to the previous room must consume again.
		if (rid !== consumedLatch.get(ctx.client)) {
			consumedLatch.delete(ctx.client);
		}
		if (!rid) return;
		// Wait for the entry: reading the key subscribes to its creation.
		if (!ctx.summaries[rid]) return;
		if (consumedLatch.get(ctx.client) === rid) return;
		consumedLatch.set(ctx.client, rid);
		// Consume on a microtask: an entry created mid-/sync-batch (a
		// timeline event precedes the batch's account data in the SDK's
		// processing) would otherwise latch before the marked-unread flag
		// lands a few statements later, leaving it unconsumed on the open
		// room. The batch is synchronous, so by microtask time the flag is
		// in. Re-check the route in case it changed before the flush.
		queueMicrotask(() => {
			if (roomId() !== rid) return;
			untrack(() => clearRoomMarkedUnread(ctx, rid));
		});
	});
}
