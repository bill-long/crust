import type { MatrixClient } from "matrix-js-sdk";

export interface SpaceCandidate {
	roomId: string;
	name: string;
}

/**
 * Parent spaces of `roomId` that can be offered as entries for a
 * `restricted` join-rule allow list ("members of this space can join").
 *
 * Candidates are sourced from both directions of the Matrix space
 * relationship, deduped:
 *  - `m.space.parent` state events on the room (the room claiming a
 *    parent), and
 *  - `m.space.child` state events on any known space pointing at this
 *    room (the space claiming the child).
 *
 * Only well-formed links count: per the spec a usable relationship
 * carries a non-empty `via` server list, so links without `via` are
 * ignored. Each candidate must resolve to a known space room
 * (`isSpaceRoom()`); the name falls back to the bare room ID. Results
 * are sorted by display name for stable rendering.
 */
export function getParentSpaceCandidates(
	client: MatrixClient,
	roomId: string,
): SpaceCandidate[] {
	const ids = new Set<string>();

	const room = client.getRoom(roomId);
	if (room) {
		for (const ev of room.currentState.getStateEvents("m.space.parent")) {
			const stateKey = ev.getStateKey?.() ?? "";
			const via = (ev.getContent() as { via?: unknown }).via;
			if (stateKey && Array.isArray(via) && via.length > 0) ids.add(stateKey);
		}
	}

	for (const candidate of client.getRooms()) {
		if (!candidate.isSpaceRoom()) continue;
		const child = candidate.currentState.getStateEvents(
			"m.space.child",
			roomId,
		);
		const via = (child?.getContent() as { via?: unknown } | undefined)?.via;
		if (Array.isArray(via) && via.length > 0) ids.add(candidate.roomId);
	}

	const out: SpaceCandidate[] = [];
	for (const id of ids) {
		// A room can never be its own parent space.
		if (id === roomId) continue;
		const space = client.getRoom(id);
		if (!space?.isSpaceRoom()) continue;
		out.push({ roomId: id, name: space.name?.trim() || id });
	}
	out.sort((a, b) => a.name.localeCompare(b.name));
	return out;
}
