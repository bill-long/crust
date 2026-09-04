import type { MatrixClient } from "matrix-js-sdk";
import type { SummariesStore } from "./summaries";

type StateEventPermissionClient = Pick<MatrixClient, "getRoom" | "getUserId">;

/**
 * The caller's membership in `roomId`, preferring Crust's summaries store.
 *
 * The store carries optimistic join/leave marks that the SDK Room does not
 * learn until the next /sync. The SDK remains the fallback for deep-linked
 * rooms omitted from the summaries store and for isolated callers/tests.
 */
export function readMyMembership(
	client: StateEventPermissionClient,
	roomId: string | undefined,
	summaries?: SummariesStore,
): string | undefined {
	if (!roomId) return undefined;
	return (
		summaries?.[roomId]?.membership ?? client.getRoom(roomId)?.getMyMembership()
	);
}

/**
 * Whether the joined user may send a state event of `type` in `roomId`.
 *
 * `RoomState.maySendStateEvent` checks power levels only. Power survives a
 * leave/ban, so every write affordance must also require current membership.
 */
export function canSendStateEvent(
	client: StateEventPermissionClient,
	roomId: string | undefined,
	type: string,
	summaries?: SummariesStore,
): boolean {
	if (!roomId || readMyMembership(client, roomId, summaries) !== "join") {
		return false;
	}
	const room = client.getRoom(roomId);
	const userId = client.getUserId();
	if (!room || !userId) return false;
	try {
		return room.currentState.maySendStateEvent(type, userId);
	} catch {
		return false;
	}
}
