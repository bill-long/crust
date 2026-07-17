import { createStore } from "solid-js/store";
import { loadPersisted, savePersisted } from "../lib/persistedSignal";
import {
	DEFAULT_SCREEN_SHARE_QUALITY,
	isScreenShareQuality,
	type ScreenShareQuality,
} from "../lib/screenShareQuality";
import { STORAGE_KEYS } from "../lib/storageKeys";

const SETTINGS_KEY = STORAGE_KEYS.settings;

// Small validated-enum lists: each union type, its parse-time membership
// check, and (where applicable) its UI options derive from ONE const
// list, mirroring SCREEN_SHARE_QUALITIES in lib/screenShareQuality.ts.
const TIME_FORMATS = ["12h", "24h"] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

const MIC_MODES = ["voice-activity", "push-to-talk", "push-to-mute"] as const;
export type MicMode = (typeof MIC_MODES)[number];

function isOneOf<T extends string>(list: readonly T[], v: unknown): v is T {
	return (list as readonly unknown[]).includes(v);
}

export interface UserSettings {
	/** Whether to auto-fetch GIF URLs from CDN for inline display. */
	autoDownloadGifs: boolean;
	/** UI zoom level as a percentage (50–200). */
	zoomLevel: number;
	/** Clock format. */
	timeFormat: TimeFormat;
	/** Whether desktop notifications are enabled. */
	desktopNotifications: boolean;
	/**
	 * Whether background Web Push notifications are enabled (delivered via the
	 * service worker + push gateway even when the app is closed). Distinct from
	 * `desktopNotifications`, which only fires while the app is open.
	 */
	backgroundNotifications: boolean;
	/** Whether to play a sound for incoming messages in other rooms. */
	notificationSound: boolean;
	/**
	 * Whether to fetch and render OpenGraph preview cards for links in
	 * messages. Mirrors the Matrix `m.room.preview_urls` account-data
	 * `disable` flag (inverted).
	 */
	urlPreviews: boolean;
	/**
	 * Whether to render a click-to-load inline HTML5 player for direct video
	 * links (e.g. raw `.mp4` URLs) in messages. The player never contacts the
	 * third-party origin until the user clicks play; this flag only controls
	 * whether the poster/player is offered at all. Distinct from `urlPreviews`,
	 * which governs homeserver-proxied OpenGraph cards.
	 */
	inlineMediaPlayers: boolean;
	/**
	 * `MediaDeviceInfo.deviceId` to use as the native RTC microphone, or
	 * empty string for the system default. Consumed by the Phase 2 LiveKit
	 * room wrapper (#122).
	 */
	rtcMicDeviceId: string;
	/**
	 * `MediaDeviceInfo.deviceId` to use as the native RTC camera, or
	 * empty string for the system default. Consumed by the Phase 3 LiveKit
	 * room wrapper (#122).
	 */
	rtcCamDeviceId: string;
	/**
	 * Outgoing screen-share quality. Maps to a getDisplayMedia capture
	 * constraint + encoder ceiling (see `lib/screenShareQuality.ts`).
	 * LiveKit's stock default encodes screen shares at 1080p15
	 * (~2.5 Mbps), which looks choppy for motion-heavy shares; presets
	 * let the sharing user pick higher frame rates, resolutions (up to
	 * native monitor size, #407), and bitrate ceilings, at the cost of
	 * more upload + CPU.
	 */
	rtcScreenShareQuality: ScreenShareQuality;
	/**
	 * Whether call video tiles render a diagnostic overlay with the live
	 * received resolution, frame rate, bitrate, and codec (#408). Off by
	 * default; useful for verifying screen-share quality end-to-end
	 * without server-side wire inspection.
	 */
	rtcShowCallStats: boolean;
	/**
	 * Mic transmission mode (Phase 6 of #122 - issue #108).
	 * - `"voice-activity"`: always transmit when not manually muted.
	 * - `"push-to-talk"`: transmit only while `micHotkey` is held.
	 * - `"push-to-mute"`: transmit unless `micHotkey` is held.
	 *
	 * In PTT/PTM modes, an unbound `micHotkey` falls back to
	 * voice-activity behavior (see `src/stores/voice.ts`) so the user
	 * isn't silently muted forever after picking a mode.
	 */
	micMode: MicMode;
	/**
	 * Hotkey combo for PTT/PTM. `code` is `KeyboardEvent.code`
	 * (e.g. `"Space"`, `"KeyT"`); `null` means a modifier-only combo
	 * (e.g. just Ctrl). `null` for the whole object means unbound.
	 */
	micHotkey: MicHotkey | null;
}

export interface MicHotkey {
	ctrl: boolean;
	shift: boolean;
	alt: boolean;
	meta: boolean;
	/** `KeyboardEvent.code`, or `null` for a modifier-only combo. */
	code: string | null;
}

const defaults: UserSettings = {
	autoDownloadGifs: true,
	zoomLevel: 100,
	timeFormat: "12h",
	desktopNotifications: false,
	backgroundNotifications: false,
	notificationSound: true,
	urlPreviews: true,
	inlineMediaPlayers: true,
	rtcMicDeviceId: "",
	rtcCamDeviceId: "",
	rtcScreenShareQuality: DEFAULT_SCREEN_SHARE_QUALITY,
	rtcShowCallStats: false,
	micMode: "voice-activity",
	micHotkey: null,
};

function loadBool(
	obj: Record<string, unknown>,
	key: string,
	fallback: boolean,
): boolean {
	return typeof obj[key] === "boolean" ? (obj[key] as boolean) : fallback;
}

// Validates a JSON-parsed settings object field-by-field, falling back to the
// default for each absent/malformed field. Structural validation is this
// callback's job (loadPersisted handles the JSON-syntax try/catch); a
// non-object payload yields the full defaults.
function parseSettings(parsed: unknown): UserSettings {
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
		timeFormat: isOneOf(TIME_FORMATS, obj.timeFormat)
			? obj.timeFormat
			: defaults.timeFormat,
		desktopNotifications: loadBool(
			obj,
			"desktopNotifications",
			defaults.desktopNotifications,
		),
		backgroundNotifications: loadBool(
			obj,
			"backgroundNotifications",
			defaults.backgroundNotifications,
		),
		notificationSound: loadBool(
			obj,
			"notificationSound",
			defaults.notificationSound,
		),
		urlPreviews: loadBool(obj, "urlPreviews", defaults.urlPreviews),
		inlineMediaPlayers: loadBool(
			obj,
			"inlineMediaPlayers",
			defaults.inlineMediaPlayers,
		),
		rtcMicDeviceId:
			typeof obj.rtcMicDeviceId === "string"
				? obj.rtcMicDeviceId
				: defaults.rtcMicDeviceId,
		rtcCamDeviceId:
			typeof obj.rtcCamDeviceId === "string"
				? obj.rtcCamDeviceId
				: defaults.rtcCamDeviceId,
		rtcScreenShareQuality: isScreenShareQuality(obj.rtcScreenShareQuality)
			? obj.rtcScreenShareQuality
			: defaults.rtcScreenShareQuality,
		rtcShowCallStats: loadBool(
			obj,
			"rtcShowCallStats",
			defaults.rtcShowCallStats,
		),
		micMode: isOneOf(MIC_MODES, obj.micMode) ? obj.micMode : defaults.micMode,
		micHotkey: parseMicHotkey(obj.micHotkey),
	};
}

/**
 * Exported for tests. Validates a persisted `micHotkey` value loaded from
 * storage, returning `null` for any malformed or empty binding so the
 * downstream voice-store anti-footgun fallback applies.
 */
export function parseMicHotkey(raw: unknown): MicHotkey | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== "object") return null;
	const h = raw as Record<string, unknown>;
	if (
		typeof h.ctrl !== "boolean" ||
		typeof h.shift !== "boolean" ||
		typeof h.alt !== "boolean" ||
		typeof h.meta !== "boolean"
	) {
		return null;
	}
	const code = h.code;
	if (code !== null && typeof code !== "string") return null;
	const normalizedCode =
		typeof code === "string" && code.length > 0 ? code : null;
	// Reject "empty" bindings (no modifiers AND no code). Otherwise the voice
	// store sees `micHotkey !== null` and treats it as a real binding,
	// defeating the unbound-hotkey anti-footgun fallback for PTT/PTM.
	if (!h.ctrl && !h.shift && !h.alt && !h.meta && normalizedCode === null) {
		return null;
	}
	return {
		ctrl: h.ctrl,
		shift: h.shift,
		alt: h.alt,
		meta: h.meta,
		code: normalizedCode,
	};
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

// Module-level singleton store - property-level reactivity so consumers
// reading e.g. settings.timeFormat don't re-render on zoomLevel changes.
const [settings, setSettings] = createStore<UserSettings>(
	loadPersisted(SETTINGS_KEY, parseSettings, { ...defaults }),
);

function save(): void {
	savePersisted(SETTINGS_KEY, settings);
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
