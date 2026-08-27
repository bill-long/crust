import type { GlobalSearchHit, RoomHitGroup } from "./useGlobalSearch";

/**
 * The grouped list, flattened into one sequence of rows.
 *
 * A listbox owns its options directly, so a room heading has to be a sibling
 * of the options it introduces rather than a wrapper around them - nesting
 * the options inside a per-room element would break that ownership. The
 * member list flattens its role sections for the same reason.
 */
export type FlatRow =
	| { kind: "header"; roomId: string; count: number }
	| { kind: "hit"; hit: GlobalSearchHit };

export function flattenGroups(groups: readonly RoomHitGroup[]): FlatRow[] {
	const rows: FlatRow[] = [];
	for (const group of groups) {
		rows.push({
			kind: "header",
			roomId: group.roomId,
			// The room's whole count, matching the status line - not the
			// number of its hits that happen to be on this page.
			count: group.total,
		});
		for (const hit of group.hits) rows.push({ kind: "hit", hit });
	}
	return rows;
}

/**
 * What the panel promises about the result set it just showed.
 *
 * Returns null when there is nothing to qualify. A search that quietly
 * omitted a third of someone's rooms, or stopped scanning early, reads
 * exactly like one that found everything - so whenever that is the case it
 * has to be said.
 */
export function coverageNote(
	mode: "server" | "local",
	locallyCovered: number,
	encryptedRoomCount: number,
	scanTruncated: boolean,
	serverUnsupported: boolean,
): string | null {
	if (mode === "local") {
		// "unavailable" is a claim about the server, and only the latch
		// knows it: one rate-limited or 502'd request also lands here, and
		// saying the same thing tells the user not to bother retrying when
		// retrying is exactly what would work.
		const why = serverUnsupported
			? "Server search is unavailable."
			: "Server search could not be reached just now.";
		return scanTruncated
			? `${why} This client also stopped scanning before the end of its history. Showing what it found in messages already loaded.`
			: `${why} Showing matches from messages already loaded in this client.`;
	}
	if (scanTruncated) {
		// "N of M", not "N". The ceiling is shared across rooms, so it can
		// stop in room 3 of 40 - and a note naming only the 2 it finished
		// reads as though 2 was the whole set, when 37 were never opened.
		return `Encrypted rooms are searched from local history, and this client reached ${locallyCovered} of ${encryptedRoomCount}: the server cannot read them.`;
	}
	if (locallyCovered > 0) {
		// Not "were not searched": they are searched, from this client's own
		// history, because the server cannot read them. The caveat is depth,
		// not absence. Verb as well as noun - a plural-only helper produces
		// "1 encrypted room were searched".
		return locallyCovered === 1
			? "1 encrypted room was searched from local history only: the server cannot read it."
			: `${locallyCovered} encrypted rooms were searched from local history only: the server cannot read them.`;
	}
	return null;
}

/**
 * The line read out by the results' live region.
 *
 * Pure, and outside the panel, because the region has to be mounted before
 * its text changes for a screen reader to announce it - which means it lives
 * in the pane, above the `<Show>` that mounts the panel.
 */
export function searchStatusMessage(input: {
	status: "idle" | "searching" | "results" | "empty" | "error";
	error: string | null;
	total: number;
	totalRooms: number;
	/**
	 * Whether the server is holding more, not whether another page of
	 * already-counted hits exists - `hasMore` is true for both, and the
	 * second is not a reason to call a complete count partial.
	 */
	moreOnServer: boolean;
}): string {
	if (input.status === "idle") return "";
	if (input.status === "searching") return "Searching…";
	if (input.status === "empty") {
		// Appended here too. A server page that projects to nothing but
		// carries `next_batch` leaves the status at "empty" with the pager
		// mounted over an empty list, so a failed press used to replace the
		// only text the panel shows - and the sidebar then never said the
		// search had found nothing again until the next successful retry.
		return input.error
			? `No messages found. ${input.error}`
			: "No messages found.";
	}
	if (input.status === "error") return input.error ?? "Search failed.";
	const counted = `${input.total} ${
		input.total === 1 ? "result" : "results"
	} in ${input.totalRooms} ${input.totalRooms === 1 ? "room" : "rooms"}`;
	// "so far" only when the server may still be holding some. A local scan
	// counted everything it found, so `hasMore` there means "more of the
	// counted hits to page through".
	// Not `hasMore`: in server mode that is also true when the 20-row window
	// simply has more of the counted hits behind it - including every hit the
	// encrypted-room scan supplied, which on this project's own homeserver is
	// most of them. Announcing "so far" for a complete count is the same kind
	// of dishonesty as hiding a partial one.
	const withMore = input.moreOnServer
		? `${counted} so far, more available`
		: counted;
	// Appended, not substituted. A failed page no longer removes its own
	// button - it is left in place so the press can be repeated - so the
	// error is not self-clearing, and replacing the count with it left the
	// live region reading "Couldn't load more results." for as long as the
	// search stayed up.
	return input.error ? `${withMore}. ${input.error}` : withMore;
}
