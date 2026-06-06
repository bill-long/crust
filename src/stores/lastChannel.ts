import { createSignal } from "solid-js";

const STORAGE_KEY = "crust:last-channel";

// Map of space room ID -> the room ID the user last viewed within that space.
type LastChannelMap = Record<string, string>;

function load(): LastChannelMap {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return {};
		const out: LastChannelMap = {};
		for (const [key, value] of Object.entries(
			parsed as Record<string, unknown>,
		)) {
			if (typeof value === "string") out[key] = value;
		}
		return out;
	} catch {
		return {};
	}
}

function save(state: LastChannelMap): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// localStorage full or unavailable — best-effort
	}
}

// Module-level singleton — one signal, shared by all consumers.
const [state, setState] = createSignal<LastChannelMap>(load());

/** The room ID last viewed in the given space, or undefined if none. */
export function getLastChannel(spaceId: string): string | undefined {
	return state()[spaceId];
}

/** Record the last-viewed room for a space. Persists immediately. */
export function setLastChannel(spaceId: string, roomId: string): void {
	// Functional update so callers in a tracked scope (e.g. the recording
	// effect in Layout) don't subscribe to this signal by reading state().
	let next: LastChannelMap | undefined;
	setState((prev) => {
		if (prev[spaceId] === roomId) return prev;
		next = { ...prev, [spaceId]: roomId };
		return next;
	});
	if (next) save(next);
}

/** Test-only: reset in-memory state and clear persistence. */
export function _resetLastChannelsForTests(): void {
	setState({});
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		// best-effort
	}
}
