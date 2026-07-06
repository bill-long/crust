import { describe, expect, it } from "vitest";
import type { ScreenShareQuality } from "../stores/settings";
import {
	DEFAULT_SCREEN_SHARE_QUALITY,
	SCREEN_SHARE_CONTENT_HINT,
	SCREEN_SHARE_PUBLISH_OPTIONS,
	SCREEN_SHARE_QUALITY_ORDER,
	SCREEN_SHARE_QUALITY_SPECS,
	screenShareQualitySpec,
} from "./screenShareQuality";

const KEYS = Object.keys(SCREEN_SHARE_QUALITY_SPECS) as ScreenShareQuality[];

describe("screenShareQualitySpec", () => {
	it("resolves each quality key to its own spec", () => {
		for (const key of KEYS) {
			expect(screenShareQualitySpec(key)).toBe(SCREEN_SHARE_QUALITY_SPECS[key]);
		}
	});

	it("falls back to the default spec when the quality is undefined", () => {
		expect(screenShareQualitySpec(undefined)).toBe(
			SCREEN_SHARE_QUALITY_SPECS[DEFAULT_SCREEN_SHARE_QUALITY],
		);
	});
});

describe("screen-share preset invariants (#385/#388)", () => {
	it("captures at least as fast as the encoder is capped, for every preset", () => {
		// The capture constraint must feed the encoder ceiling: LiveKit caps
		// screen capture at 30fps by default, so an encoder allowed 60fps would
		// only ever see 30 captured frames unless the capture frameRate is raised
		// to at least the cap. The contract is capture >= cap (an over-capture
		// preset would be valid), so assert that rather than strict equality.
		for (const key of KEYS) {
			const spec = SCREEN_SHARE_QUALITY_SPECS[key];
			expect(spec.resolution.frameRate).toBeGreaterThanOrEqual(
				spec.encoding.maxFramerate,
			);
		}
	});

	it("locks the per-preset bitrate ceilings (the core #385 fix)", () => {
		// Raising 1080p from 5 to 8 Mbps is the fix #385 was filed for; 5 Mbps
		// starves 1080p under motion. A silent revert here reintroduces exactly
		// that bug while every other assertion stays green, so pin the ceilings.
		expect(SCREEN_SHARE_QUALITY_SPECS["720p30"].encoding.maxBitrate).toBe(
			2_000_000,
		);
		expect(SCREEN_SHARE_QUALITY_SPECS["1080p30"].encoding.maxBitrate).toBe(
			8_000_000,
		);
		expect(SCREEN_SHARE_QUALITY_SPECS["1080p60"].encoding.maxBitrate).toBe(
			8_000_000,
		);
	});

	it("actually captures the high-frame-rate preset at 60fps", () => {
		const spec = SCREEN_SHARE_QUALITY_SPECS["1080p60"];
		expect(spec.resolution.frameRate).toBe(60);
		expect(spec.encoding.maxFramerate).toBe(60);
		expect(spec.resolution.width).toBe(1920);
		expect(spec.resolution.height).toBe(1080);
	});

	it("orders presets lowest-cost first and covers exactly the spec keys", () => {
		expect([...SCREEN_SHARE_QUALITY_ORDER].sort()).toEqual([...KEYS].sort());
		// Non-decreasing pixel-rate (width*height*fps) down the picker order.
		const cost = (q: ScreenShareQuality): number => {
			const r = SCREEN_SHARE_QUALITY_SPECS[q].resolution;
			return r.width * r.height * r.frameRate;
		};
		for (let i = 1; i < SCREEN_SHARE_QUALITY_ORDER.length; i++) {
			expect(cost(SCREEN_SHARE_QUALITY_ORDER[i])).toBeGreaterThanOrEqual(
				cost(SCREEN_SHARE_QUALITY_ORDER[i - 1]),
			);
		}
	});

	it("uses a valid, known key as the default", () => {
		expect(KEYS).toContain(DEFAULT_SCREEN_SHARE_QUALITY);
		expect(SCREEN_SHARE_QUALITY_ORDER).toContain(DEFAULT_SCREEN_SHARE_QUALITY);
	});
});

describe("screen-share publish options (#385/#388)", () => {
	it("locks the motion-biased, single-layer VP9 publish decisions", () => {
		// A regression here silently degrades motion quality (or, for videoCodec,
		// risks a black tile for VP9-incapable subscribers under E2EE - a
		// deliberate tradeoff). Changing any of these should be a conscious call.
		expect(SCREEN_SHARE_PUBLISH_OPTIONS).toEqual({
			videoCodec: "vp9",
			scalabilityMode: "L1T3",
			simulcast: false,
			degradationPreference: "maintain-framerate",
		});
	});

	it("hints motion on every capture", () => {
		expect(SCREEN_SHARE_CONTENT_HINT).toBe("motion");
	});
});
