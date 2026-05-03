import { createSignal } from "solid-js";

const STORAGE_KEY = "crust:layout";

interface LayoutState {
	membersPaneVisible: boolean;
}

const defaults: LayoutState = {
	membersPaneVisible: false,
};

function load(): LayoutState {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...defaults };
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return { ...defaults };
		const obj = parsed as Record<string, unknown>;
		return {
			membersPaneVisible:
				typeof obj.membersPaneVisible === "boolean"
					? obj.membersPaneVisible
					: defaults.membersPaneVisible,
		};
	} catch {
		return { ...defaults };
	}
}

function save(state: LayoutState): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// localStorage full or unavailable — best-effort
	}
}

// Module-level singleton — one signal, shared by all consumers.
const [layoutState, setLayoutState] = createSignal<LayoutState>(load());

/** Whether the members pane is currently visible (reactive). */
export function membersPaneVisible(): boolean {
	return layoutState().membersPaneVisible;
}

/** Toggle the members pane visibility. Persists to localStorage immediately. */
export function toggleMembersPane(): void {
	const next = {
		...layoutState(),
		membersPaneVisible: !layoutState().membersPaneVisible,
	};
	setLayoutState(next);
	save(next);
}

/** Explicitly set the members pane visibility. */
export function setMembersPaneVisible(visible: boolean): void {
	const next = { ...layoutState(), membersPaneVisible: visible };
	setLayoutState(next);
	save(next);
}
