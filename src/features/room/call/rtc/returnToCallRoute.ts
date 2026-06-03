import type { SummariesStore } from "../../../../client/summaries";

/**
 * Pick the best app route to navigate to in order to "return" the user
 * to a given call's room. Used by the `MiniCallWidget` when the user
 * is viewing a different room (or `/settings/*`) and clicks
 * "Return to call".
 *
 * Rules (in priority order):
 *   1. If the call's room is a DM → `/dm/<roomId>`.
 *   2. Otherwise, if the user is currently viewing a space whose
 *      direct children include the call's room → preserve that
 *      space context: `/space/<spaceId>/<roomId>`.
 *   3. Otherwise → `/home/<roomId>`.
 *
 * Hard invariant: NEVER produce `/space/X/Y` unless `Y` is a direct
 * child of `X` in the summaries store. A user navigating between
 * spaces should never be flipped into a space they were not already
 * in, and we must never construct a path that the route guard /
 * sidebar would treat as inconsistent. When in doubt the helper
 * falls back to `/home/...`.
 *
 * Pure function — does no signal reads of its own so it is safe to
 * call from inside or outside reactive scopes.
 */
export function pickReturnToCallRoute(
	summaries: SummariesStore,
	callRoomId: string,
	currentSpaceId: string | undefined,
): string {
	const encodedRoom = encodeURIComponent(callRoomId);
	const summary = summaries[callRoomId];
	// Unknown room (e.g. just got kicked, or summary not yet hydrated) →
	// route to /home. Otherwise we could emit /space/<spaceId>/<roomId>
	// purely because the space lists the room in its `children` even
	// though we have no joined-membership summary for it — which lands
	// the user on an empty / error pane inside that space.
	if (!summary) {
		return `/home/${encodedRoom}`;
	}
	if (summary.isDirect) {
		return `/dm/${encodedRoom}`;
	}
	if (currentSpaceId) {
		const space = summaries[currentSpaceId];
		if (space?.isSpace && space.children.includes(callRoomId)) {
			return `/space/${encodeURIComponent(currentSpaceId)}/${encodedRoom}`;
		}
	}
	return `/home/${encodedRoom}`;
}
