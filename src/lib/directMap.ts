import { EventType, type MatrixClient } from "matrix-js-sdk";

/**
 * The `m.direct` account-data map: a record of user ID -> list of room IDs
 * that are direct messages with that user. See
 * https://spec.matrix.org/v1.11/client-server-api/#mdirect.
 */
export type DirectMap = Record<string, string[]>;

/**
 * Normalize raw `m.direct` content into a `DirectMap`.
 *
 * This is the one set of rules for the structure. The content is
 * server-controlled and may be malformed, so:
 * - anything that is not a plain non-null object (including an array)
 *   yields an empty map;
 * - entries whose value is not an array are dropped;
 * - non-string room IDs inside an array are dropped.
 *
 * The result has a null prototype: the keys are server-controlled user IDs,
 * so a key like `"__proto__"` must become an ordinary entry, not pollute
 * Object's prototype.
 */
function parseDirectMap(content: unknown): DirectMap {
	const map: DirectMap = Object.create(null);
	if (!content || typeof content !== "object" || Array.isArray(content)) {
		return map;
	}
	for (const [userId, rooms] of Object.entries(content)) {
		if (Array.isArray(rooms)) {
			map[userId] = rooms.filter((r): r is string => typeof r === "string");
		}
	}
	return map;
}

/**
 * Read and normalize the current user's `m.direct` account data. The result
 * is a null-prototype object (see `parseDirectMap`); use `addDmToMap` to
 * derive content that is safe to write back.
 */
export function readDirectMap(client: MatrixClient): DirectMap {
	return parseDirectMap(client.getAccountData(EventType.Direct)?.getContent());
}

/**
 * Return a new `m.direct` map with `roomId` recorded under `userId`,
 * preserving every other entry and de-duplicating within the user's list.
 * Pure: does not mutate the input.
 *
 * The result is a plain-prototype object ready for `client.setAccountData`:
 * the SDK deep-compares new content against the stored value with
 * `hasOwnProperty`, which a null-prototype object lacks. The map is built on
 * a null prototype (so a `"__proto__"` user ID is an ordinary entry) and
 * spread at the end, which copies own keys without invoking any setter.
 */
export function addDmToMap(
	map: DirectMap,
	userId: string,
	roomId: string,
): DirectMap {
	const next: DirectMap = Object.create(null);
	for (const [user, rooms] of Object.entries(map)) {
		next[user] = [...rooms];
	}
	const list = next[userId] ?? [];
	if (!list.includes(roomId)) list.push(roomId);
	next[userId] = list;
	return { ...next };
}
