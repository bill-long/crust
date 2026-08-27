import type { SummariesStore } from "../client/summaries";

/**
 * The route that opens `roomId`.
 *
 * One definition, because getting it wrong is invisible until it isn't: a
 * direct room reached through `/home/` is canonicalised to `/dm/` by
 * `Layout`, and that is a different route branch, so the pane remounts -
 * taking any `?event=` jump request with it. A permalink or a search hit
 * then opens the right room and silently fails to scroll to the message.
 *
 * `openSpaceId` keeps a hit inside the space the user is browsing when the
 * room is one of its direct children; a space route lists only those, so
 * anything deeper would open a room its own sidebar cannot show.
 */
export function roomRoutePath(
	summaries: SummariesStore,
	roomId: string,
	openSpaceId?: string,
): string {
	const encoded = encodeURIComponent(roomId);
	if (summaries[roomId]?.isDirect) return `/dm/${encoded}`;
	if (
		openSpaceId !== undefined &&
		(summaries[openSpaceId]?.children ?? []).includes(roomId)
	) {
		return `/space/${encodeURIComponent(openSpaceId)}/${encoded}`;
	}
	return `/home/${encoded}`;
}
