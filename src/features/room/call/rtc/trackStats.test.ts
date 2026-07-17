import { describe, expect, it } from "vitest";
import {
	formatAnomalyLine,
	formatBitrate,
	formatFrameLine,
	formatRateLine,
	readInboundVideoStats,
} from "./trackStats";
import { inboundVideo, makeReport, vp9Codec } from "./trackStats.test-utils";

describe("readInboundVideoStats", () => {
	it("reads dimensions, fps, counters, and the referenced codec", () => {
		const stats = readInboundVideoStats(
			makeReport([
				inboundVideo({ framesDropped: 12, freezeCount: 3 }),
				vp9Codec,
			]),
		);
		expect(stats).toEqual({
			entryId: "in-1",
			bytesReceived: null,
			timestamp: null,
			frameWidth: 2560,
			frameHeight: 1440,
			framesPerSecond: 60,
			codec: "VP9",
			decoder: null,
			framesDropped: 12,
			freezeCount: 3,
		});
	});

	it("maps powerEfficientDecoder to hw/sw and its absence to null", () => {
		const hw = readInboundVideoStats(
			makeReport([inboundVideo({ powerEfficientDecoder: true }), vp9Codec]),
		);
		expect(hw.decoder).toBe("hw");
		const sw = readInboundVideoStats(
			makeReport([inboundVideo({ powerEfficientDecoder: false }), vp9Codec]),
		);
		expect(sw.decoder).toBe("sw");
		const unknown = readInboundVideoStats(
			makeReport([inboundVideo(), vp9Codec]),
		);
		expect(unknown.decoder).toBeNull();
	});

	it("returns empty stats when the report has no video inbound-rtp entry", () => {
		const audioOnly = readInboundVideoStats(
			makeReport([
				{ id: "in-a", type: "inbound-rtp", kind: "audio", frameWidth: 7 },
				{ id: "out-1", type: "outbound-rtp", kind: "video", frameWidth: 9 },
			]),
		);
		expect(audioOnly.entryId).toBeNull();
		expect(audioOnly.frameWidth).toBeNull();
		expect(audioOnly.codec).toBeNull();
		expect(audioOnly.framesDropped).toBe(0);
	});

	it("tolerates a bare codec name without a media-type prefix", () => {
		const stats = readInboundVideoStats(
			makeReport([
				inboundVideo(),
				{ id: "codec-1", type: "codec", mimeType: "vp9" },
			]),
		);
		expect(stats.codec).toBe("VP9");
	});

	it("tolerates a missing or dangling codec reference", () => {
		const noCodecId = readInboundVideoStats(
			makeReport([inboundVideo({ codecId: undefined })]),
		);
		expect(noCodecId.codec).toBeNull();
		const dangling = readInboundVideoStats(
			makeReport([inboundVideo({ codecId: "codec-missing" })]),
		);
		expect(dangling.codec).toBeNull();
	});

	it("prefers the later entry on a full SSRC-restart tie (same timestamp, neither decoding)", () => {
		const stats = readInboundVideoStats(
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
		);
		expect(stats.entryId).toBe("in-new");
	});

	it("prefers the freshest timestamp, then the actively-decoding entry", () => {
		const freshest = readInboundVideoStats(
			makeReport([
				inboundVideo({ id: "in-old", timestamp: 6_000 }),
				inboundVideo({ id: "in-new", timestamp: 5_000 }),
			]),
		);
		expect(freshest.entryId).toBe("in-old");
		const decoding = readInboundVideoStats(
			makeReport([
				inboundVideo({ id: "in-a", timestamp: 5_000 }),
				inboundVideo({
					id: "in-b",
					framesPerSecond: undefined,
					timestamp: 5_000,
				}),
			]),
		);
		expect(decoding.entryId).toBe("in-a");
	});

	it("reads the byte counter and timestamp for the bitrate delta", () => {
		const stats = readInboundVideoStats(
			makeReport([
				inboundVideo({ bytesReceived: 125_000, timestamp: 1_000 }),
				vp9Codec,
			]),
		);
		expect(stats.bytesReceived).toBe(125_000);
		expect(stats.timestamp).toBe(1_000);
	});

	it("treats non-numeric stats fields as absent", () => {
		const stats = readInboundVideoStats(
			makeReport([
				inboundVideo({
					frameWidth: "1920",
					framesPerSecond: Number.NaN,
					framesDropped: null,
				}),
				vp9Codec,
			]),
		);
		expect(stats.frameWidth).toBeNull();
		expect(stats.framesPerSecond).toBeNull();
		expect(stats.framesDropped).toBe(0);
		// Height was untouched and still reads through.
		expect(stats.frameHeight).toBe(1440);
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
		expect(formatFrameLine(2560, 1440, 59.94)).toBe("2560x1440 · 60fps");
		expect(formatFrameLine(1920, 1080, 0)).toBe("1920x1080 · 0fps");
	});

	it("omits the fps segment when the rate was never measured", () => {
		expect(formatFrameLine(1280, 720, null)).toBe("1280x720");
	});

	it("says 'no frames decoded' without a frame size", () => {
		expect(formatFrameLine(null, null, null)).toBe("no frames decoded");
		expect(formatFrameLine(1280, null, 30)).toBe("no frames decoded");
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
