/**
 * The single source of truth for screen-share quality preset keys, in
 * picker order (lowest cost first). The union type, the persisted-value
 * validation in `stores/settings.ts`, the settings picker, and the spec
 * table's completeness (via `Record<ScreenShareQuality, ...>`) all
 * derive from this list, so adding a preset is a one-place change. Kept
 * HERE (not in the settings store) so `lib/` never imports runtime
 * values from `stores/` - the store consumes this module, one
 * direction, no side-effect-laden import cycle to arm.
 */
export const SCREEN_SHARE_QUALITIES = [
	"720p30",
	"1080p30",
	"1080p60",
	"1440p60",
	"native60",
] as const;

/** Outgoing screen-share quality preset key. */
export type ScreenShareQuality = (typeof SCREEN_SHARE_QUALITIES)[number];

/**
 * Membership guard for persisted/untrusted values - THE one place the
 * "is this a known preset key" check lives.
 */
export function isScreenShareQuality(v: unknown): v is ScreenShareQuality {
	return (SCREEN_SHARE_QUALITIES as readonly unknown[]).includes(v);
}

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
 *   overriding `frameRate` here - a 60fps encoding alone would still only see
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
 *   resolution encode. Multi-spatial-layer (L3T3) was investigated for the
 *   high-resolution presets (#407) and is NOT possible: livekit-client
 *   force-overrides VP9 screen share to L1T3 ("vp9 svc with screenshare
 *   cannot encode multiple spatial layers - doing so reduces publish
 *   resolution to minimal resolution"), so passing it here keeps intent
 *   explicit rather than fighting the SDK. Accepted tradeoff, sharper at
 *   the 12-18 Mbps presets: a subscriber on a weak downlink can only be
 *   stepped down in frame rate, never resolution.
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

/** Default when nothing is persisted - balanced 1080p30. */
export const DEFAULT_SCREEN_SHARE_QUALITY: ScreenShareQuality = "1080p30";

export const SCREEN_SHARE_QUALITY_SPECS: Record<
	ScreenShareQuality,
	ScreenShareQualitySpec
> = {
	// Two DIFFERENT capture-box contracts, both riding getDisplayMedia's
	// aspect-preserving, per-dimension fit-within-box downscale (ideal
	// constraints never upscale):
	// - The capped presets' rectangular WxH box IS their pixel budget:
	//   any monitor - portrait included - downscales to fit within it, so
	//   the bitrate ceiling below is never asked to carry more pixels
	//   than the preset's nominal size. (A square box here would let a
	//   non-16:9 monitor encode up to 2x the pixels under the same
	//   ceiling - blockier motion at higher CPU cost, the opposite of
	//   what a capped preset is for.)
	// - native60's SQUARE box promises native capture instead: squareness
	//   makes the fit orientation-proof, since a rectangular box shrinks
	//   any monitor whose long edge exceeds the box's short side when
	//   rotated.
	// Bitrates are ceilings sized for VP9 motion content at the preset's
	// nominal size; static content stays far below them, and machines
	// that can't sustain the encode shed resolution first via
	// maintain-framerate.
	"720p30": {
		label: "720p · 30fps - smooth, lowest bandwidth",
		resolution: { width: 1280, height: 720, frameRate: 30 },
		encoding: { maxBitrate: 2_000_000, maxFramerate: 30 },
	},
	"1080p30": {
		label: "1080p · 30fps - balanced (default)",
		resolution: { width: 1920, height: 1080, frameRate: 30 },
		// 8 Mbps ceiling (was 5): 5 Mbps starves 1080p under motion. It's a
		// ceiling, not a target - static content still compresses well under it.
		encoding: { maxBitrate: 8_000_000, maxFramerate: 30 },
	},
	"1080p60": {
		label: "1080p · 60fps - high frame rate, for games/motion",
		resolution: { width: 1920, height: 1080, frameRate: 60 },
		encoding: { maxBitrate: 8_000_000, maxFramerate: 60 },
	},
	"1440p60": {
		label: "1440p · 60fps - high resolution, more upload/CPU",
		resolution: { width: 2560, height: 1440, frameRate: 60 },
		encoding: { maxBitrate: 12_000_000, maxFramerate: 60 },
	},
	native60: {
		label: "Native · 60fps - full monitor resolution, most upload/CPU",
		// 8K square (see the contracts note above): every monitor with
		// edges up to 7680 captures at its true native size in either
		// orientation. (Zero dims would be livekit's uncapped convention,
		// but livekit skips its whole dimension-constraint block INCLUDING
		// frameRate for zero dims, and its capture options offer no other
		// typed frame-rate carrier.) The 18 Mbps ceiling is sized for ~4K
		// pixel rates; monitors beyond that degrade gracefully via
		// maintain-framerate.
		resolution: { width: 7680, height: 7680, frameRate: 60 },
		encoding: { maxBitrate: 18_000_000, maxFramerate: 60 },
	},
};

/** Resolve a quality key to its spec, falling back to the default. */
export function screenShareQualitySpec(
	quality: ScreenShareQuality | undefined,
): ScreenShareQualitySpec {
	return SCREEN_SHARE_QUALITY_SPECS[quality ?? DEFAULT_SCREEN_SHARE_QUALITY];
}
