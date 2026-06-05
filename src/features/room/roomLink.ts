import type { Room } from "matrix-js-sdk";

/**
 * Build a shareable matrix.to link for a Room.
 *
 * Per the matrix.to spec:
 *   - If the room has a canonical alias, link by alias — aliases self-
 *     resolve via the alias's homeserver, so no `?via=` hint is needed.
 *   - Otherwise link by room ID with up to `viaLimit` `?via=` server
 *     hints, picked from the joined membership by descending power level
 *     so the link resolves cleanly when the target client doesn't share
 *     a server with us.
 */
export interface RoomLink {
	url: string;
	displayLabel: string;
}

const MATRIX_TO_BASE = "https://matrix.to/#/";
const DEFAULT_VIA_LIMIT = 3;

/**
 * Join rules for which a shareable matrix.to link can actually let the
 * recipient in: directly (`public`), by knocking (`knock` /
 * `knock_restricted`), or as a member of a parent space (`restricted`).
 * Excludes `invite` and any unset rule, where the recipient would still
 * need an explicit invite — so a link affordance should be hidden there.
 */
const SHAREABLE_JOIN_RULES = new Set([
	"public",
	"knock",
	"restricted",
	"knock_restricted",
]);

/**
 * Whether a room's join rule lets a shared link recipient join (or knock)
 * without first receiving an explicit invite.
 */
export function canShareJoinLink(joinRule: string | undefined | null): boolean {
	return joinRule != null && SHAREABLE_JOIN_RULES.has(joinRule);
}

export function buildRoomLink(
	room: Room,
	viaLimit = DEFAULT_VIA_LIMIT,
): RoomLink {
	const alias = room.getCanonicalAlias();
	if (alias) {
		return {
			url: `${MATRIX_TO_BASE}${encodeURIComponent(alias)}`,
			displayLabel: alias,
		};
	}

	const roomId = room.roomId;
	const encodedId = encodeURIComponent(roomId);
	const via = pickViaServers(room, viaLimit);
	if (via.length === 0) {
		return {
			url: `${MATRIX_TO_BASE}${encodedId}`,
			displayLabel: roomId,
		};
	}
	const viaParams = via.map((s) => `via=${encodeURIComponent(s)}`).join("&");
	return {
		url: `${MATRIX_TO_BASE}${encodedId}?${viaParams}`,
		displayLabel: roomId,
	};
}

/**
 * Pick up to `limit` unique server names from the joined membership of
 * `room`, ordered by descending power level (ties broken by membership
 * iteration order, i.e. the SDK's internal map order).
 *
 * Exported for unit testing.
 */
export function pickViaServers(
	room: Room,
	limit = DEFAULT_VIA_LIMIT,
): string[] {
	if (limit <= 0) return [];
	const members = room.getJoinedMembers();
	// Normalize powerLevel to 0 before subtracting: RoomMember.powerLevel can
	// be undefined for members whose m.room.member event predates a power
	// level event, which would produce NaN comparisons and unstable ordering.
	const sorted = [...members].sort(
		(a, b) => (b.powerLevel ?? 0) - (a.powerLevel ?? 0),
	);
	const seen = new Set<string>();
	const result: string[] = [];
	for (const m of sorted) {
		const server = extractServer(m.userId);
		if (!server || seen.has(server)) continue;
		seen.add(server);
		result.push(server);
		if (result.length >= limit) break;
	}
	return result;
}

/**
 * Build a minimal matrix.to link from a room ID or alias when the SDK
 * Room object isn't available yet (initial sync, deep links). The
 * resulting link has no `?via=` hints, so it relies on the alias's
 * homeserver (for aliases) or the target client's federation reach
 * (for raw room IDs). Use `buildRoomLink(room)` whenever a Room is
 * available — it produces a more robust link with via hints.
 */
export function buildRoomLinkById(idOrAlias: string): RoomLink {
	return {
		url: `${MATRIX_TO_BASE}${encodeURIComponent(idOrAlias)}`,
		displayLabel: idOrAlias,
	};
}

function extractServer(userId: string): string | null {
	// userId format: @localpart:server. The first ":" after "@" splits
	// localpart from server; the server may itself contain ":" for ports
	// or IPv6 literals, so keep everything after the first split.
	// Per the Matrix spec a user ID must start with "@" and have a non-empty
	// localpart, so the splitting ":" must appear at index >= 2. Reject any
	// userId where the colon is at position 1 (e.g. "@:server") or absent.
	const colon = userId.indexOf(":", 1);
	if (colon < 2) return null;
	if (!userId.startsWith("@")) return null;
	const server = userId.slice(colon + 1);
	return server.length > 0 ? server : null;
}
