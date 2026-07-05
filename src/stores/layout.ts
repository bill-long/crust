import { createPersistedSignal } from "../lib/persistedSignal";

const STORAGE_KEY = "crust:layout";

interface LayoutState {
	membersPaneVisible: boolean;
}

const defaults: LayoutState = {
	membersPaneVisible: false,
};

function parse(raw: unknown): LayoutState {
	if (typeof raw !== "object" || raw === null) return { ...defaults };
	const obj = raw as Record<string, unknown>;
	return {
		membersPaneVisible:
			typeof obj.membersPaneVisible === "boolean"
				? obj.membersPaneVisible
				: defaults.membersPaneVisible,
	};
}

const store = createPersistedSignal<LayoutState>(STORAGE_KEY, parse, {
	...defaults,
});

/** Whether the members pane is currently visible (reactive). */
export function membersPaneVisible(): boolean {
	return store.get().membersPaneVisible;
}

/** Toggle the members pane visibility. Persists to localStorage immediately. */
export function toggleMembersPane(): void {
	store.set((prev) => ({
		...prev,
		membersPaneVisible: !prev.membersPaneVisible,
	}));
}

/** Explicitly set the members pane visibility. Persists immediately. */
export function setMembersPaneVisible(visible: boolean): void {
	store.set((prev) => ({ ...prev, membersPaneVisible: visible }));
}
