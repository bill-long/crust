import { createStore } from "solid-js/store";

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
	/** Whether to play a sound for incoming messages in other rooms. */
	notificationSound: boolean;
	/**
	 * Whether to fetch and render OpenGraph preview cards for links in
	 * messages. Mirrors the Matrix `m.room.preview_urls` account-data
	 * `disable` flag (inverted).
	 */
	urlPreviews: boolean;
	/**
	 * `MediaDeviceInfo.deviceId` to use as the native RTC microphone, or
	 * empty string for the system default. Consumed by the Phase 2 LiveKit
	 * room wrapper (#122).
	 */
	rtcMicDeviceId: string;
}

const defaults: UserSettings = {
	autoDownloadGifs: true,
	zoomLevel: 100,
	timeFormat: "12h",
	desktopNotifications: false,
	notificationSound: true,
	urlPreviews: true,
	rtcMicDeviceId: "",
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
			urlPreviews: loadBool(obj, "urlPreviews", defaults.urlPreviews),
			rtcMicDeviceId:
				typeof obj.rtcMicDeviceId === "string"
					? obj.rtcMicDeviceId
					: defaults.rtcMicDeviceId,
		};
	} catch {
		return { ...defaults };
	}
}

function applyZoom(level: number): void {
	if (
		typeof document !== "undefined" &&
		typeof CSS !== "undefined" &&
		CSS.supports?.("zoom", "1")
	) {
		const z = level / 100;
		document.documentElement.style.zoom = `${z}`;
		document.documentElement.style.setProperty("--app-zoom", `${z}`);
	}
}

// Module-level singleton store — property-level reactivity so consumers
// reading e.g. settings.timeFormat don't re-render on zoomLevel changes.
const [settings, setSettings] = createStore<UserSettings>(load());

function save(): void {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch {
		// localStorage full or unavailable — best-effort
	}
}

/** Apply persisted zoom level. Call once during app bootstrap. */
export function initZoom(): void {
	if (settings.zoomLevel !== 100) {
		applyZoom(settings.zoomLevel);
	}
}

/** Read current user settings (reactive at the property level). */
export function userSettings(): Readonly<UserSettings> {
	return settings;
}

/** Update a single setting. Persists to localStorage immediately. */
export function updateSetting<K extends keyof UserSettings>(
	key: K,
	value: UserSettings[K],
): void {
	if (key === "zoomLevel") {
		const zoom = Math.round(Math.min(200, Math.max(50, value as number)));
		setSettings("zoomLevel", zoom);
		save();
		applyZoom(zoom);
		return;
	}
	setSettings(key, value);
	save();
}
