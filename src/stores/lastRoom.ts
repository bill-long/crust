import { createPersistedSignal } from "../lib/persistedSignal";
import { STORAGE_KEYS } from "../lib/storageKeys";

const STORAGE_KEY = STORAGE_KEYS.lastRoom;

// The room the user last had open, across all sections (home / space / DM).
// Stored structurally rather than as a raw route so the route can be rebuilt
// and re-validated on launch: `roomId` is the room itself; `spaceId` is the
// space it was viewed under, if any (undefined for home rooms and DMs). Unlike
// the per-space `lastChannel` store this is a single global value — the most
// recent room regardless of which section it lived in.
export interface LastRoom {
	roomId: string;
	spaceId?: string;
}

function parse(raw: unknown): LastRoom | null {
	if (
		typeof raw !== "object" ||
		raw === null ||
		typeof (raw as LastRoom).roomId !== "string"
	) {
		return null;
	}
	const { roomId, spaceId } = raw as LastRoom;
	return typeof spaceId === "string" ? { roomId, spaceId } : { roomId };
}

const store = createPersistedSignal<LastRoom | null>(STORAGE_KEY, parse, null);

/** The room the user last had open, or null if none recorded. */
export function getLastRoom(): LastRoom | null {
	return store.get();
}

/**
 * Record the last-opened room. `spaceId` is the space it was viewed under, if
 * any. Persists immediately.
 */
export function setLastRoom(roomId: string, spaceId?: string): void {
	// Functional update so callers in a tracked scope (e.g. the recording
	// effect in Layout) don't subscribe to this signal by reading the value.
	store.set((prev) => {
		if (prev && prev.roomId === roomId && prev.spaceId === spaceId) return prev;
		return spaceId ? { roomId, spaceId } : { roomId };
	});
}

/** Test-only: reset in-memory state and clear persistence. */
export function _resetLastRoomForTests(): void {
	store.reset();
}
