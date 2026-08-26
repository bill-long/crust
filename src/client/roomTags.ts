import type { MatrixClient, Room } from "matrix-js-sdk";
import { reportError } from "../lib/reportError";
import { enqueueKeyedWrite } from "../lib/writeQueue";
import type { SummariesStore } from "./summaries";

/** Spec room tags surfaced in the sidebar (m.tag account data, 11.19). */
export const FAVOURITE_TAG = "m.favourite";
export const LOW_PRIORITY_TAG = "m.lowpriority";

export type SidebarRoomTag = typeof FAVOURITE_TAG | typeof LOW_PRIORITY_TAG;

/**
 * The two sidebar-relevant tag flags for `room`, read from the SDK's
 * `Room.tags` (kept current by the SDK from `m.tag` account data). Other
 * (custom) tags are ignored - Crust's flat list surfaces only these two.
 */
export function getRoomTagState(room: Room): {
	favourite: boolean;
	lowPriority: boolean;
} {
	return {
		favourite: FAVOURITE_TAG in room.tags,
		lowPriority: LOW_PRIORITY_TAG in room.tags,
	};
}

/**
 * The slice of `ClientContextValue` the tag actions need. Optimistic-first
 * like the marked-unread actions: the summary flag flips immediately, the
 * tag write confirms, and a failure converges back to the SDK's value.
 */
interface RoomTagsContext {
	client: MatrixClient;
	summaries: SummariesStore;
	optimisticallySetRoomTag: (
		roomId: string,
		tag: SidebarRoomTag,
		value: boolean,
	) => void;
}

/**
 * Per-client chains serializing tag writes, keyed by room + tag: a rapid
 * double-toggle issues a PUT and a DELETE for the same tag on independent
 * requests, which could otherwise commit out of order server-side.
 */
const tagWriteChains = new WeakMap<MatrixClient, Map<string, Promise<void>>>();

function enqueueTagWrite(
	client: MatrixClient,
	roomId: string,
	tag: SidebarRoomTag,
	value: boolean,
): Promise<void> {
	let chains = tagWriteChains.get(client);
	if (!chains) {
		chains = new Map();
		tagWriteChains.set(client, chains);
	}
	return enqueueKeyedWrite(chains, `${roomId}\n${tag}`, () =>
		(value
			? client.setRoomTag(roomId, tag, {})
			: client.deleteRoomTag(roomId, tag)
		).then(() => {}),
	);
}

/**
 * Toggle `tag` on `roomId`. The summary flag flips instantly (the row
 * moves section without waiting for the round-trip); a failed write
 * converges back to the authoritative SDK tag state - never a blind
 * invert, so a same-value echo that landed mid-flight isn't clobbered -
 * and surfaces a toast (the section move is the only feedback surface, so
 * a silent failure would look like success).
 */
export function toggleRoomTag(
	ctx: RoomTagsContext,
	roomId: string,
	tag: SidebarRoomTag,
): void {
	const summary = ctx.summaries[roomId];
	if (!summary) return;
	const next = !(tag === FAVOURITE_TAG
		? summary.isFavourite
		: summary.isLowPriority);
	ctx.optimisticallySetRoomTag(roomId, tag, next);
	enqueueTagWrite(ctx.client, roomId, tag, next).catch((err) => {
		const room = ctx.client.getRoom(roomId);
		const authoritative = room ? getRoomTagState(room) : null;
		ctx.optimisticallySetRoomTag(
			roomId,
			tag,
			tag === FAVOURITE_TAG
				? (authoritative?.favourite ?? false)
				: (authoritative?.lowPriority ?? false),
		);
		reportError(err, {
			userMessage: "Couldn't update the room tag.",
			logLabel: "Room tag update failed",
		});
	});
}
