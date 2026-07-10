import { createPersistedSignal } from "../lib/persistedSignal";
import { STORAGE_KEYS } from "../lib/storageKeys";

const STORAGE_KEY = STORAGE_KEYS.lastChannel;

// Map of space room ID -> the room ID the user last viewed within that space.
// Room IDs are external data, so use null-prototype maps to keep lookups and
// writes safe from prototype-pollution edge cases (e.g. `__proto__`,
// `toString`) — consistent with the timeline reaction maps.
type LastChannelMap = Record<string, string>;

function emptyMap(): LastChannelMap {
	return Object.create(null) as LastChannelMap;
}

function parse(raw: unknown): LastChannelMap {
	if (typeof raw !== "object" || raw === null) return emptyMap();
	const out = emptyMap();
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === "string") out[key] = value;
	}
	return out;
}

const store = createPersistedSignal<LastChannelMap>(
	STORAGE_KEY,
	parse,
	emptyMap(),
);

/** The room ID last viewed in the given space, or undefined if none. */
export function getLastChannel(spaceId: string): string | undefined {
	return store.get()[spaceId];
}

/** Record the last-viewed room for a space. Persists immediately. */
export function setLastChannel(spaceId: string, roomId: string): void {
	// Functional update so callers in a tracked scope (e.g. the recording
	// effect in Layout) don't subscribe to this signal by reading the value.
	store.set((prev) => {
		if (prev[spaceId] === roomId) return prev;
		return Object.assign(emptyMap(), prev, { [spaceId]: roomId });
	});
}

/** Test-only: reset in-memory state and clear persistence. */
export function _resetLastChannelsForTests(): void {
	store.reset();
}
