import { EventType, type MatrixClient, type Room } from "matrix-js-sdk";
import { type Accessor, createEffect, untrack } from "solid-js";
import { reportError } from "../lib/reportError";
import type { RoomSummary, SummariesStore } from "./summaries";

/** Stable account-data type for the marked-unread flag (MSC2867). */
export const MARKED_UNREAD_TYPE = EventType.MarkedUnread;
/**
 * Pre-stabilization type some clients still write; read as a fallback so a
 * flag set elsewhere isn't invisible here. Writes use the stable type only
 * (matching Element).
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
 * Whether "Mark as unread" is currently actionable for `summary`: not when
 * an unread indicator is already showing. A muted room's hidden count does
 * NOT block the action - marking it unread is how the user makes it
 * visible despite the mute. This is the single gate for every surface that
 * offers the action (the room-list context menu and the room-pane overflow
 * item), so the two can't drift. Callers without mute information (the
 * room pane, where mute state is room-list-local) omit `opts.muted`, which
 * errs toward offering the action.
 */
export function canMarkRoomUnread(
	summary: RoomSummary | undefined,
	opts: { muted?: boolean } = {},
): boolean {
	if (!summary) return false;
	return !(
		(summary.unreadCount > 0 && opts.muted !== true) ||
		summary.markedUnread
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
	let chains = flagWriteChains.get(client);
	if (!chains) {
		chains = new Map();
		flagWriteChains.set(client, chains);
	}
	const write = (): Promise<void> =>
		client
			.setRoomAccountData(roomId, MARKED_UNREAD_TYPE, { unread })
			.then(() => {});
	// No chain pending: issue the request synchronously (the common case;
	// also keeps the optimistic flip and the PUT in the same task).
	const pending = chains.get(roomId);
	const next = pending ? pending.then(write) : write();
	// Store a settled-safe tail: a failed write must neither block later
	// writes nor surface as an unhandled rejection (the caller of THIS
	// write owns its error handling via the returned promise). Drop the
	// entry once the tail settles so the map doesn't retain every room
	// ever touched.
	const stored = next.catch(() => {});
	chains.set(roomId, stored);
	stored.then(() => {
		if (chains.get(roomId) === stored) chains.delete(roomId);
	});
	return next;
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
		ctx.optimisticallySetMarkedUnread(roomId, false);
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
		ctx.optimisticallySetMarkedUnread(roomId, true);
		reportError(err, { logLabel: "Clearing marked-unread failed" });
	});
}

/**
 * The room whose marked-unread flag the open-room view last consumed.
 * Module-level rather than component state deliberately: Layout is
 * re-created on route-definition boundary crossings (e.g. a settings
 * round-trip), and a remount with the same room still open is not a new
 * "open" - it must not consume a flag the user set while viewing the room.
 */
let lastConsumedRoomId: string | null = null;

export function _resetMarkedUnreadConsumerForTests(): void {
	lastConsumedRoomId = null;
}

/**
 * Consume the marked-unread flag when a room is opened (MSC2867: viewing
 * the room clears it). "Opened" means the viewed room id transitioned - a
 * flag set while the room is already open (the room-pane overflow action,
 * or a right-click on the open room's row) survives until the room is
 * NEXT opened. The effect tracks the summary entry's identity (a
 * top-level store key) so a cold-launch restore straight into a marked
 * room still clears once the initial sync creates the entry, but not the
 * `markedUnread` field itself (a field-level store write), so marking the
 * open room can't re-trigger consumption. A flag arriving from another
 * device while the room is open likewise persists until reopen - same
 * open-consumes semantics Element applies.
 */
export function useMarkedUnreadConsumer(
	ctx: MarkedUnreadContext,
	roomId: Accessor<string | undefined>,
): void {
	createEffect(() => {
		const rid = roomId();
		if (!rid) {
			// Leaving the room view re-arms consumption, so mark-and-go-back
			// followed by reopening the same room clears the flag.
			lastConsumedRoomId = null;
			return;
		}
		// Wait for the entry: reading the key subscribes to its creation.
		if (!ctx.summaries[rid]) return;
		if (rid === lastConsumedRoomId) return;
		lastConsumedRoomId = rid;
		untrack(() => clearRoomMarkedUnread(ctx, rid));
	});
}
