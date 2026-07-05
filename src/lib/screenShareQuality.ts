import type { ScreenShareQuality } from "../stores/settings";

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
 *
 * The per-preset `resolution`/`encoding` knobs are joined at publish time by a
 * set of content-agnostic, preset-invariant knobs - see
 * `SCREEN_SHARE_PUBLISH_OPTIONS` and `SCREEN_SHARE_CONTENT_HINT` below.
 */
export interface ScreenShareQualitySpec {
	/** Label shown in the settings picker. */
	label: string;
	/** getDisplayMedia capture constraint (structurally a LiveKit `VideoResolution`). */
	resolution: { width: number; height: number; frameRate: number };
	/** Encoder caps (structurally a LiveKit `VideoEncoding`). */
	encoding: { maxBitrate: number; maxFramerate: number };
}

/**
 * getDisplayMedia `contentHint` applied to every screen-share capture.
 *
 * Biased toward motion (issue #385): the reported complaint is that games/video
 * degrade under motion while static content stays sharp - the signature of
 * bitrate starvation against a fixed cap. `"motion"` tells the encoder to hold
 * frame rate and spend bits on movement rather than preserving a static-sharp
 * image that smears the instant anything moves. The tradeoff is slightly softer
 * static text, accepted deliberately here.
 *
 * Note: livekit-client already forces the underlying track's contentHint to
 * "motion" for VP9 screen share, so this is belt-and-suspenders that also keeps
 * the intent explicit at our call site (and correct should the codec change).
 *
 * Structurally a LiveKit `ScreenShareCaptureOptions["contentHint"]`; kept as a
 * bare literal so this module needn't import `livekit-client`.
 */
export const SCREEN_SHARE_CONTENT_HINT = "motion" as const;

/**
 * Publish-time options shared by every screen-share preset - the
 * content-agnostic half of the fix for motion starvation (issue #385). Spread
 * into the `setScreenShareEnabled` publish options alongside the per-preset
 * `screenShareEncoding`.
 *
 * - `videoCodec: "vp9"` - far better quality-per-bit than VP8 for motion at the
 *   same bitrate. Caveat: livekit-client only adds a VP8 backup codec for
 *   NON-E2EE publishes (it suppresses the backup whenever the room is
 *   encrypted), so in an E2EE room - Crust's default - a subscriber that can't
 *   decode WebRTC VP9 gets NO fallback and sees a black share tile. Acceptable
 *   here only because Crust's users are not on VP9-incapable clients; the
 *   notable ones are iOS/iPadOS (all browsers are WebKit, no VP9 WebRTC decode)
 *   and some Safari-on-Mac builds. Revisit this codec if that ever changes.
 * - `scalabilityMode: "L1T3"` - a SINGLE full-resolution spatial layer (the SVC
 *   equivalent of `simulcast: false`) so the entire bitrate budget feeds one
 *   full-res encode instead of being split across half/quarter-res layers that
 *   buy little for screen share. The 3 temporal layers are near-free and let
 *   the SFU drop frame rate for constrained subscribers without a separate
 *   resolution encode. (livekit-client already forces L1T3 for VP9 screen
 *   share; passing it keeps intent explicit and is consistent, not fighting the
 *   SDK.) Tradeoff: with a single spatial layer, a subscriber on a weak downlink
 *   can only be dropped in frame rate, not resolution - matching the issue's
 *   explicit "keep everyone on one full-res layer" decision.
 * - `simulcast: false` - SVC codecs already ignore simulcast, but this documents
 *   intent and covers the VP8 backup path.
 * - `degradationPreference: "maintain-framerate"` - under CPU/bandwidth
 *   pressure, shed resolution before frame rate so motion stays smooth.
 *
 * Structurally a subset of LiveKit's `TrackPublishOptions`; kept as bare
 * literals (`as const`) so this module needn't import `livekit-client`. The
 * literal types are validated structurally at the call site.
 */
export const SCREEN_SHARE_PUBLISH_OPTIONS = {
	videoCodec: "vp9",
	scalabilityMode: "L1T3",
	simulcast: false,
	degradationPreference: "maintain-framerate",
} as const;

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
		// 8 Mbps ceiling (was 5): 5 Mbps starves 1080p under motion. It's a
		// ceiling, not a target - static content still compresses well under it.
		encoding: { maxBitrate: 8_000_000, maxFramerate: 30 },
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
