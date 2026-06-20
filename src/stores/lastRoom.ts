import { createSignal } from "solid-js";

const STORAGE_KEY = "crust:last-room";

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

function load(): LastRoom | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof (parsed as LastRoom).roomId !== "string"
		) {
			return null;
		}
		const { roomId, spaceId } = parsed as LastRoom;
		return typeof spaceId === "string" ? { roomId, spaceId } : { roomId };
	} catch {
		return null;
	}
}

function save(value: LastRoom): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
	} catch {
		// localStorage full or unavailable — best-effort
	}
}

// Module-level singleton — one signal, shared by all consumers.
const [state, setState] = createSignal<LastRoom | null>(load());

/** The room the user last had open, or null if none recorded. */
export function getLastRoom(): LastRoom | null {
	return state();
}

/**
 * Record the last-opened room. `spaceId` is the space it was viewed under, if
 * any. Persists immediately.
 */
export function setLastRoom(roomId: string, spaceId?: string): void {
	// Functional update so callers in a tracked scope (e.g. the recording
	// effect in Layout) don't subscribe to this signal by reading state().
	let next: LastRoom | undefined;
	setState((prev) => {
		if (prev && prev.roomId === roomId && prev.spaceId === spaceId) return prev;
		next = spaceId ? { roomId, spaceId } : { roomId };
		return next;
	});
	if (next) save(next);
}

/** Test-only: reset in-memory state and clear persistence. */
export function _resetLastRoomForTests(): void {
	setState(null);
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// best-effort
	}
}
