import type { SummariesStore } from "../client/summaries";
import { getSpaceRooms } from "../client/summaries-selectors";
import { getLastChannel } from "../stores/lastChannel";

/**
 * The path to open a space at: its last-viewed channel when one is
 * remembered and still a joined child of the space, otherwise the space
 * landing view (issue #226). Shared by the spaces sidebar's tiles and the
 * room list's subspace rows so both entry points land in the same place
 * (#443).
 */
export function spaceLandingPath(
	summaries: SummariesStore,
	spaceId: string,
): string {
	const remembered = getLastChannel(spaceId);
	if (
		remembered &&
		getSpaceRooms(summaries, spaceId).some((r) => r.roomId === remembered)
	) {
		return `/space/${encodeURIComponent(spaceId)}/${encodeURIComponent(remembered)}`;
	}
	return `/space/${encodeURIComponent(spaceId)}`;
}
