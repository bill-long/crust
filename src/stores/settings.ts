import { createSignal } from "solid-js";

const SETTINGS_KEY = "crust:settings";

export interface UserSettings {
	/** Whether to auto-fetch GIF URLs from CDN for inline display. */
	autoDownloadGifs: boolean;
	/** UI zoom level as a percentage (50–200). */
	zoomLevel: number;
	/** Clock format. */
	timeFormat: "12h" | "24h";
	/** Whether desktop notifications are enabled. */
	desktopNotifications: boolean;
	/** Whether to play a sound on notification. */
	notificationSound: boolean;
	/** Notify on @-mentions. */
	notifyMentions: boolean;
	/** Notify on direct messages. */
	notifyDirectMessages: boolean;
	/** Notify on all room messages. */
	notifyAllMessages: boolean;
}

const defaults: UserSettings = {
	autoDownloadGifs: true,
	zoomLevel: 100,
	timeFormat: "12h",
	desktopNotifications: false,
	notificationSound: true,
	notifyMentions: true,
	notifyDirectMessages: true,
	notifyAllMessages: false,
};

function loadBool(
	obj: Record<string, unknown>,
	key: string,
	fallback: boolean,
): boolean {
	return typeof obj[key] === "boolean" ? (obj[key] as boolean) : fallback;
}

function load(): UserSettings {
	try {
		const raw = localStorage.getItem(SETTINGS_KEY);
		if (!raw) return { ...defaults };
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return { ...defaults };
		const obj = parsed as Record<string, unknown>;
		return {
			autoDownloadGifs: loadBool(
				obj,
				"autoDownloadGifs",
				defaults.autoDownloadGifs,
			),
			zoomLevel:
				typeof obj.zoomLevel === "number" &&
				obj.zoomLevel >= 50 &&
				obj.zoomLevel <= 200
					? obj.zoomLevel
					: defaults.zoomLevel,
			timeFormat:
				obj.timeFormat === "12h" || obj.timeFormat === "24h"
					? obj.timeFormat
					: defaults.timeFormat,
			desktopNotifications: loadBool(
				obj,
				"desktopNotifications",
				defaults.desktopNotifications,
			),
			notificationSound: loadBool(
				obj,
				"notificationSound",
				defaults.notificationSound,
			),
			notifyMentions: loadBool(obj, "notifyMentions", defaults.notifyMentions),
			notifyDirectMessages: loadBool(
				obj,
				"notifyDirectMessages",
				defaults.notifyDirectMessages,
			),
			notifyAllMessages: loadBool(
				obj,
				"notifyAllMessages",
				defaults.notifyAllMessages,
			),
		};
	} catch {
		return { ...defaults };
	}
}

function save(s: UserSettings): void {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
	} catch {
		// localStorage full or unavailable — best-effort
	}
}

function applyZoom(level: number): void {
	if (
		typeof document !== "undefined" &&
		"zoom" in document.documentElement.style
	) {
		const z = level / 100;
		document.documentElement.style.zoom = `${z}`;
		document.documentElement.style.setProperty("--app-zoom", `${z}`);
	}
}

// Module-level singleton — one signal, shared by all consumers.
const [settings, setSettingsInternal] = createSignal<UserSettings>(load());

/** Apply persisted zoom level. Call once during app bootstrap. */
export function initZoom(): void {
	const level = settings().zoomLevel;
	if (level !== 100) {
		applyZoom(level);
	}
}

/** Read current user settings (reactive). */
export function userSettings(): UserSettings {
	return settings();
}

/** Update a single setting. Persists to localStorage immediately. */
export function updateSetting<K extends keyof UserSettings>(
	key: K,
	value: UserSettings[K],
): void {
	if (key === "zoomLevel") {
		const zoom = Math.round(Math.min(200, Math.max(50, value as number)));
		const next = { ...settings(), zoomLevel: zoom };
		setSettingsInternal(next as UserSettings);
		save(next as UserSettings);
		applyZoom(zoom);
		return;
	}
	const next = { ...settings(), [key]: value };
	setSettingsInternal(next);
	save(next);
}
