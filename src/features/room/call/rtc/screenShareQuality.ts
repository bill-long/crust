import type { ScreenShareQuality } from "../../../../stores/settings";

/**
 * A selectable screen-share quality, mapped to the LiveKit capture
 * constraint + encoder caps it implies. Kept as plain objects (no
 * `livekit-client` import) so this can be consumed from the settings UI and
 * the room hook without pulling the SDK into either bundle eagerly.
 *
 * Two distinct knobs matter, and BOTH must move together:
 *
 * - `resolution` is the getDisplayMedia capture constraint. LiveKit's default
 *   screen-capture constraint caps frameRate at 30, so reaching 60fps REQUIRES
 *   overriding `frameRate` here — a 60fps encoding alone would still only see
 *   30 captured frames.
 * - `encoding` is the encoder ceiling. LiveKit's stock default is
 *   `h1080fps15` (1080p, 15fps, ~2.5 Mbps), which is what makes a motion-heavy
 *   share (e.g. a game) look choppy regardless of how it was captured.
 */
export interface ScreenShareQualitySpec {
	/** Label shown in the settings picker. */
	label: string;
	/** getDisplayMedia capture constraint (structurally a LiveKit `VideoResolution`). */
	resolution: { width: number; height: number; frameRate: number };
	/** Encoder caps (structurally a LiveKit `VideoEncoding`). */
	encoding: { maxBitrate: number; maxFramerate: number };
}

/** Picker order, lowest cost first. */
export const SCREEN_SHARE_QUALITY_ORDER: readonly ScreenShareQuality[] = [
	"720p30",
	"1080p30",
	"1080p60",
];

/** Default when nothing is persisted — balanced 1080p30. */
export const DEFAULT_SCREEN_SHARE_QUALITY: ScreenShareQuality = "1080p30";

export const SCREEN_SHARE_QUALITY_SPECS: Record<
	ScreenShareQuality,
	ScreenShareQualitySpec
> = {
	"720p30": {
		label: "720p · 30fps — smooth, lowest bandwidth",
		resolution: { width: 1280, height: 720, frameRate: 30 },
		encoding: { maxBitrate: 2_000_000, maxFramerate: 30 },
	},
	"1080p30": {
		label: "1080p · 30fps — balanced (default)",
		resolution: { width: 1920, height: 1080, frameRate: 30 },
		encoding: { maxBitrate: 5_000_000, maxFramerate: 30 },
	},
	"1080p60": {
		label: "1080p · 60fps — high frame rate, for games/motion",
		resolution: { width: 1920, height: 1080, frameRate: 60 },
		encoding: { maxBitrate: 8_000_000, maxFramerate: 60 },
	},
};

/** Resolve a quality key to its spec, falling back to the default. */
export function screenShareQualitySpec(
	quality: ScreenShareQuality | undefined,
): ScreenShareQualitySpec {
	return SCREEN_SHARE_QUALITY_SPECS[quality ?? DEFAULT_SCREEN_SHARE_QUALITY];
}
