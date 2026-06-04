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
 *   3. Otherwise, if some OTHER known space lists the call's room as
 *      a direct child → `/space/<thatSpaceId>/<roomId>`. When several
 *      spaces qualify, pick the lexicographically-smallest space id so
 *      the choice is deterministic across reloads. Matrix does not
 *      currently expose a "primary parent" through `summaries` (the
 *      `m.space.parent` canonical bit is not surfaced), so an
 *      arbitrary-but-stable choice is the best we can do until that
 *      metadata is added.
 *   4. Otherwise → `/home/<roomId>` (true orphan, or a kicked / not-
 *      yet-hydrated summary).
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
		if (
			space?.isSpace &&
			space.membership === "join" &&
			space.children.includes(callRoomId)
		) {
			return `/space/${encodeURIComponent(currentSpaceId)}/${encodedRoom}`;
		}
	}
	// Walk all known spaces looking for one that contains the call room
	// as a direct child. This is what makes "Return" work when the user
	// is in space B but the call is in space A — the previous behavior
	// fell back to /home and silently dropped the call's space context.
	// Determinism: sort the candidate ids so the same call always
	// resolves to the same space across reloads / re-renders.
	// Filter to joined spaces only — `SummariesStore` can hold stale
	// "leave" / "invite" entries (e.g. after the user is kicked from a
	// space) and routing into one would land them on a pane the rest
	// of the UI treats as inaccessible (sidebar, `getSpaces`, etc. all
	// gate on `membership === "join"`).
	const candidates: string[] = [];
	for (const id in summaries) {
		if (!Object.hasOwn(summaries, id)) continue;
		if (id === currentSpaceId) continue; // already considered above
		const s = summaries[id];
		if (
			s.isSpace &&
			s.membership === "join" &&
			s.children.includes(callRoomId)
		) {
			candidates.push(id);
		}
	}
	if (candidates.length > 0) {
		candidates.sort();
		return `/space/${encodeURIComponent(candidates[0])}/${encodedRoom}`;
	}
	return `/home/${encodedRoom}`;
}
