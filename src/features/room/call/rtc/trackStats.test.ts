import { describe, expect, it } from "vitest";
import {
	formatAnomalyLine,
	formatBitrate,
	formatFrameLine,
	formatLimitationLine,
	formatRateLine,
	readVideoTrackStats,
} from "./trackStats";
import {
	inboundVideo,
	makeReport,
	outboundVideo,
	vp9Codec,
} from "./trackStats.test-utils";

describe("readVideoTrackStats (receive)", () => {
	it("reads dimensions, fps, counters, and the referenced codec", () => {
		const stats = readVideoTrackStats(
			makeReport([
				inboundVideo({ framesDropped: 12, freezeCount: 3 }),
				vp9Codec,
			]),
			"receive",
		);
		expect(stats).toEqual({
			entryId: "in-1",
			bytes: null,
			timestamp: null,
			byteEntryIds: null,
			frameWidth: 2560,
			frameHeight: 1440,
			framesPerSecond: 60,
			codec: "VP9",
			accel: null,
			framesDropped: 12,
			freezeCount: 3,
			qualityLimitationReason: null,
			qualityLimitationSeconds: null,
		});
	});

	it("maps powerEfficientDecoder to hw/sw and its absence to null", () => {
		const hw = readVideoTrackStats(
			makeReport([inboundVideo({ powerEfficientDecoder: true }), vp9Codec]),
			"receive",
		);
		expect(hw.accel).toBe("hw");
		const sw = readVideoTrackStats(
			makeReport([inboundVideo({ powerEfficientDecoder: false }), vp9Codec]),
			"receive",
		);
		expect(sw.accel).toBe("sw");
		const unknown = readVideoTrackStats(
			makeReport([inboundVideo(), vp9Codec]),
			"receive",
		);
		expect(unknown.accel).toBeNull();
	});

	it("returns empty stats when the report has no video inbound-rtp entry", () => {
		const audioOnly = readVideoTrackStats(
			makeReport([
				{ id: "in-a", type: "inbound-rtp", kind: "audio", frameWidth: 7 },
				{ id: "out-1", type: "outbound-rtp", kind: "video", frameWidth: 9 },
			]),
			"receive",
		);
		expect(audioOnly.entryId).toBeNull();
		expect(audioOnly.frameWidth).toBeNull();
		expect(audioOnly.codec).toBeNull();
		expect(audioOnly.framesDropped).toBe(0);
	});

	it("tolerates a bare codec name without a media-type prefix", () => {
		const stats = readVideoTrackStats(
			makeReport([
				inboundVideo(),
				{ id: "codec-1", type: "codec", mimeType: "vp9" },
			]),
			"receive",
		);
		expect(stats.codec).toBe("VP9");
	});

	it("tolerates a missing or dangling codec reference", () => {
		const noCodecId = readVideoTrackStats(
			makeReport([inboundVideo({ codecId: undefined })]),
			"receive",
		);
		expect(noCodecId.codec).toBeNull();
		const dangling = readVideoTrackStats(
			makeReport([inboundVideo({ codecId: "codec-missing" })]),
			"receive",
		);
		expect(dangling.codec).toBeNull();
	});

	it("prefers the later entry on a full SSRC-restart tie (same timestamp, neither decoding)", () => {
		const stats = readVideoTrackStats(
			makeReport([
				inboundVideo({
					id: "in-old",
					framesPerSecond: undefined,
					timestamp: 5_000,
				}),
				inboundVideo({
					id: "in-new",
					framesPerSecond: undefined,
					frameWidth: undefined,
					frameHeight: undefined,
					timestamp: 5_000,
				}),
				vp9Codec,
			]),
			"receive",
		);
		expect(stats.entryId).toBe("in-new");
	});

	it("prefers the freshest timestamp, then the actively-decoding entry", () => {
		const freshest = readVideoTrackStats(
			makeReport([
				inboundVideo({ id: "in-old", timestamp: 6_000 }),
				inboundVideo({ id: "in-new", timestamp: 5_000 }),
			]),
			"receive",
		);
		expect(freshest.entryId).toBe("in-old");
		const decoding = readVideoTrackStats(
			makeReport([
				inboundVideo({ id: "in-a", timestamp: 5_000 }),
				inboundVideo({
					id: "in-b",
					framesPerSecond: undefined,
					timestamp: 5_000,
				}),
			]),
			"receive",
		);
		expect(decoding.entryId).toBe("in-a");
	});

	it("reads the byte counter and timestamp for the bitrate delta", () => {
		const stats = readVideoTrackStats(
			makeReport([
				inboundVideo({ bytesReceived: 125_000, timestamp: 1_000 }),
				vp9Codec,
			]),
			"receive",
		);
		expect(stats.bytes).toBe(125_000);
		expect(stats.timestamp).toBe(1_000);
	});

	it("treats non-numeric stats fields as absent", () => {
		const stats = readVideoTrackStats(
			makeReport([
				inboundVideo({
					frameWidth: "1920",
					framesPerSecond: Number.NaN,
					framesDropped: null,
				}),
				vp9Codec,
			]),
			"receive",
		);
		expect(stats.frameWidth).toBeNull();
		expect(stats.framesPerSecond).toBeNull();
		expect(stats.framesDropped).toBe(0);
		// Height was untouched and still reads through.
		expect(stats.frameHeight).toBe(1440);
	});
});

describe("readVideoTrackStats (send)", () => {
	it("selects the top simulcast layer and sums bytesSent across layers", () => {
		const stats = readVideoTrackStats(
			makeReport([
				outboundVideo({
					id: "out-low",
					frameWidth: 640,
					frameHeight: 360,
					framesPerSecond: 30,
					bytesSent: 100_000,
					timestamp: 1_000,
				}),
				outboundVideo({
					id: "out-top",
					bytesSent: 900_000,
					timestamp: 1_000,
					powerEfficientEncoder: true,
				}),
				vp9Codec,
			]),
			"send",
		);
		expect(stats.entryId).toBe("out-top");
		expect(stats.frameWidth).toBe(1920);
		expect(stats.framesPerSecond).toBe(60);
		// Total upload, not just the top layer.
		expect(stats.bytes).toBe(1_000_000);
		expect(stats.codec).toBe("VP9");
		expect(stats.accel).toBe("hw");
	});

	it("trusts the spec's active boolean over a present-but-zero framesPerSecond", () => {
		const stats = readVideoTrackStats(
			makeReport([
				outboundVideo({
					id: "out-top",
					// Deactivated per the spec's own flag, but still reporting a
					// numeric fps of 0 - must not count as active.
					active: false,
					framesPerSecond: 0,
					timestamp: 1_000,
				}),
				outboundVideo({
					id: "out-low",
					active: true,
					frameWidth: 640,
					frameHeight: 360,
					framesPerSecond: 30,
					timestamp: 1_000,
				}),
			]),
			"send",
		);
		expect(stats.entryId).toBe("out-low");
	});

	it("uses timestamp only as the final tie-break (content signals first, no stamp flip-flop)", () => {
		// Identical content signals: the fresher stamp decides.
		const tie = readVideoTrackStats(
			makeReport([
				outboundVideo({ id: "out-old", timestamp: 5_000 }),
				outboundVideo({ id: "out-new", timestamp: 6_000 }),
			]),
			"send",
		);
		expect(tie.entryId).toBe("out-new");
		// Differing content signals: activity wins regardless of a fresher
		// stamp on the inactive entry, so per-entry stamp jitter can never
		// flip-flop the selection between ticks.
		const content = readVideoTrackStats(
			makeReport([
				outboundVideo({ id: "out-flowing", timestamp: 5_000 }),
				outboundVideo({
					id: "out-idle",
					active: false,
					framesPerSecond: undefined,
					timestamp: 6_000,
				}),
			]),
			"send",
		);
		expect(content.entryId).toBe("out-flowing");
	});

	it("prefers the flowing entry when both claim active at the same width", () => {
		const stats = readVideoTrackStats(
			makeReport([
				outboundVideo({
					id: "out-zombie",
					active: true,
					framesPerSecond: undefined,
					timestamp: 5_000,
				}),
				outboundVideo({
					id: "out-flowing",
					active: true,
					timestamp: 5_000,
				}),
			]),
			"send",
		);
		expect(stats.entryId).toBe("out-flowing");
	});

	it("prefers an ACTIVE lower layer over a bandwidth-deactivated larger one", () => {
		const stats = readVideoTrackStats(
			makeReport([
				outboundVideo({
					id: "out-top",
					// Deactivated: frameWidth persists from the last encoded
					// frame, but nothing is being encoded now.
					framesPerSecond: undefined,
					timestamp: 1_000,
				}),
				outboundVideo({
					id: "out-low",
					frameWidth: 640,
					frameHeight: 360,
					framesPerSecond: 30,
					timestamp: 1_000,
				}),
				vp9Codec,
			]),
			"send",
		);
		// The flowing layer wins; a false "1920x1080 stall" must not render
		// while 640x360 streams fine.
		expect(stats.entryId).toBe("out-low");
		expect(stats.frameWidth).toBe(640);
		expect(stats.framesPerSecond).toBe(30);
	});

	it("identifies the byte-sum population so the poll loop can re-baseline on layer churn", () => {
		const stats = readVideoTrackStats(
			makeReport([
				outboundVideo({ id: "out-b", bytesSent: 10, timestamp: 1_000 }),
				outboundVideo({
					id: "out-a",
					frameWidth: 640,
					bytesSent: 5,
					timestamp: 1_000,
				}),
			]),
			"send",
		);
		expect(stats.bytes).toBe(15);
		// Sorted and stable regardless of iteration order.
		expect(stats.byteEntryIds).toBe("out-a,out-b");
	});

	it("passes the live qualityLimitationReason through with its duration", () => {
		const limited = readVideoTrackStats(
			makeReport([
				outboundVideo({
					qualityLimitationReason: "cpu",
					qualityLimitationDurations: { none: 10, cpu: 34.2, bandwidth: 0 },
				}),
			]),
			"send",
		);
		expect(limited.qualityLimitationReason).toBe("cpu");
		expect(limited.qualityLimitationSeconds).toBe(34.2);

		const unlimited = readVideoTrackStats(
			makeReport([outboundVideo()]),
			"send",
		);
		expect(unlimited.qualityLimitationReason).toBe("none");
		expect(unlimited.qualityLimitationSeconds).toBeNull();
	});

	it("ignores inbound entries and reports empty when no outbound video exists", () => {
		const stats = readVideoTrackStats(
			makeReport([inboundVideo(), vp9Codec]),
			"send",
		);
		expect(stats.entryId).toBeNull();
		expect(stats.frameWidth).toBeNull();
	});

	it("never reports limitation fields on the receive side", () => {
		const stats = readVideoTrackStats(
			makeReport([inboundVideo({ qualityLimitationReason: "cpu" }), vp9Codec]),
			"receive",
		);
		expect(stats.qualityLimitationReason).toBeNull();
	});
});

describe("formatLimitationLine", () => {
	it("renders the active limitation with its rounded duration", () => {
		expect(formatLimitationLine("cpu", 34.2)).toBe("cpu limited · 34s");
		expect(formatLimitationLine("bandwidth", null)).toBe("bandwidth limited");
	});

	it("omits the duration segment for a just-started (sub-second) spell", () => {
		expect(formatLimitationLine("cpu", 0)).toBe("cpu limited");
		expect(formatLimitationLine("cpu", 0.6)).toBe("cpu limited");
	});

	it("returns null when unlimited or unknown", () => {
		expect(formatLimitationLine("none", 10)).toBeNull();
		expect(formatLimitationLine(null, null)).toBeNull();
	});
});

describe("formatBitrate", () => {
	it("formats sub-Mbps rates as whole kbps", () => {
		expect(formatBitrate(0)).toBe("0 kbps");
		expect(formatBitrate(850_000)).toBe("850 kbps");
		expect(formatBitrate(999_499)).toBe("999 kbps");
	});

	it("formats Mbps rates with one decimal, switching at the rounded kbps boundary", () => {
		expect(formatBitrate(999_500)).toBe("1.0 Mbps");
		expect(formatBitrate(8_000_000)).toBe("8.0 Mbps");
		expect(formatBitrate(17_540_000)).toBe("17.5 Mbps");
	});

	it("renders non-finite and negative input as 0 kbps", () => {
		expect(formatBitrate(Number.NaN)).toBe("0 kbps");
		expect(formatBitrate(Number.POSITIVE_INFINITY)).toBe("0 kbps");
		expect(formatBitrate(-5_000)).toBe("0 kbps");
	});
});

describe("formatFrameLine", () => {
	it("renders size and rounded fps", () => {
		expect(formatFrameLine(2560, 1440, 59.94, "receive")).toBe(
			"2560x1440 · 60fps",
		);
		expect(formatFrameLine(1920, 1080, 0, "receive")).toBe("1920x1080 · 0fps");
	});

	it("renders sub-1fps as <1fps, never a false 0fps stall", () => {
		expect(formatFrameLine(1920, 1080, 0.4, "receive")).toBe(
			"1920x1080 · <1fps",
		);
		expect(formatFrameLine(1920, 1080, 0, "receive")).toBe("1920x1080 · 0fps");
	});

	it("omits the fps segment when the rate was never measured", () => {
		expect(formatFrameLine(1280, 720, null, "receive")).toBe("1280x720");
	});

	it("labels the no-frames state per direction", () => {
		expect(formatFrameLine(null, null, null, "send")).toBe("no frames sent");
	});

	it("says 'no frames decoded' without a frame size", () => {
		expect(formatFrameLine(null, null, null, "receive")).toBe(
			"no frames decoded",
		);
		expect(formatFrameLine(1280, null, 30, "receive")).toBe(
			"no frames decoded",
		);
	});
});

describe("formatRateLine", () => {
	it("appends codec and decoder segments only when known", () => {
		expect(formatRateLine(7_940_000, "VP9", "hw")).toBe("7.9 Mbps · VP9 hw");
		expect(formatRateLine(7_940_000, "VP9", null)).toBe("7.9 Mbps · VP9");
		expect(formatRateLine(0, null, null)).toBe("0 kbps");
		// A decoder without a codec is not rendered (no dangling segment).
		expect(formatRateLine(0, null, "hw")).toBe("0 kbps");
	});

	it("omits the bitrate segment while unmeasured (null), unlike a measured zero", () => {
		expect(formatRateLine(null, "VP9", "hw")).toBe("VP9 hw");
		expect(formatRateLine(null, null, null)).toBe("");
		expect(formatRateLine(0, "VP9", null)).toBe("0 kbps · VP9");
	});
});

describe("formatAnomalyLine", () => {
	it("joins nonzero counters and pluralizes freezes", () => {
		expect(formatAnomalyLine(12, 3)).toBe("12 dropped · 3 freezes");
		expect(formatAnomalyLine(12, 1)).toBe("12 dropped · 1 freeze");
		expect(formatAnomalyLine(12, 0)).toBe("12 dropped");
		expect(formatAnomalyLine(0, 2)).toBe("2 freezes");
	});

	it("returns null when both counters are zero", () => {
		expect(formatAnomalyLine(0, 0)).toBeNull();
	});
});
