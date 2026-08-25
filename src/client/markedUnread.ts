import { EventType, type MatrixClient, type Room } from "matrix-js-sdk";
import { reportError } from "../lib/reportError";
import type { SummariesStore } from "./summaries";

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
 * The slice of `ClientContextValue` the marked-unread actions need. Both
 * actions are optimistic-first: the summary flag flips immediately and the
 * account-data write confirms (or, for marking, rolls back) afterwards.
 */
interface MarkedUnreadContext {
	client: MatrixClient;
	summaries: SummariesStore;
	optimisticallySetMarkedUnread: (roomId: string, value: boolean) => void;
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
	ctx.client
		.setRoomAccountData(roomId, MARKED_UNREAD_TYPE, { unread: true })
		.catch((err) => {
			ctx.optimisticallySetMarkedUnread(roomId, false);
			reportError(err, {
				userMessage: "Couldn't mark the room as unread.",
				logLabel: "Mark as unread failed",
			});
		});
}

/**
 * Clear the marked-unread flag when the user opens `roomId` (MSC2867:
 * viewing the room consumes the flag). Gated on the summary flag - which
 * includes optimistic state - so the common open does no account-data
 * write at all. A failed write stays console-only: the next account-data
 * sync re-delivers the authoritative flag, so nothing is silently lost.
 */
export function clearRoomMarkedUnread(
	ctx: MarkedUnreadContext,
	roomId: string,
): void {
	if (!ctx.summaries[roomId]?.markedUnread) return;
	ctx.optimisticallySetMarkedUnread(roomId, false);
	ctx.client
		.setRoomAccountData(roomId, MARKED_UNREAD_TYPE, { unread: false })
		.catch((err) => {
			reportError(err, { logLabel: "Clearing marked-unread failed" });
		});
}
