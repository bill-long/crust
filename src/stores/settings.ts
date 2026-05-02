import { createSignal } from "solid-js";

const SETTINGS_KEY = "crust:settings";

export interface UserSettings {
	/** Whether to auto-fetch GIF URLs from CDN for inline display. */
	autoDownloadGifs: boolean;
}

const defaults: UserSettings = {
	autoDownloadGifs: true,
};

function load(): UserSettings {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (!raw) return { ...defaults };
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return { ...defaults };
		const obj = parsed as Record<string, unknown>;
		return {
			autoDownloadGifs:
				typeof obj.autoDownloadGifs === "boolean"
					? obj.autoDownloadGifs
					: defaults.autoDownloadGifs,
		};
	} catch {
		return { ...defaults };
	}
}

function save(settings: UserSettings): void {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		// localStorage full or unavailable — best-effort
	}
}

// Module-level singleton — one signal, shared by all consumers.
const [settings, setSettingsInternal] = createSignal<UserSettings>(load());

/** Read current user settings (reactive). */
export function userSettings(): UserSettings {
	return settings();
}

/** Update a single setting. Persists to localStorage immediately. */
export function updateSetting<K extends keyof UserSettings>(
	key: K,
	value: UserSettings[K],
): void {
	const next = { ...settings(), [key]: value };
	setSettingsInternal(next);
	save(next);
}
