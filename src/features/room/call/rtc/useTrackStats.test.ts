import type { RemoteVideoTrack } from "livekit-client";
import { type Accessor, createRoot, createSignal, type Setter } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inboundVideo, makeReport, vp9Codec } from "./trackStats.test-utils";
import { type StatsSnapshot, useTrackStats } from "./useTrackStats";

interface MountedStats {
	dispose: () => void;
	snapshot: Accessor<StatsSnapshot | null>;
}

function mountStats(track: Accessor<RemoteVideoTrack>): MountedStats {
	return createRoot((dispose) => ({
		dispose,
		snapshot: useTrackStats(track, "receive"),
	}));
}

function statsTrack(
	getRTCStatsReport: () => Promise<RTCStatsReport | undefined>,
): RemoteVideoTrack {
	return { getRTCStatsReport } as unknown as RemoteVideoTrack;
}

describe("useTrackStats", () => {
	const mounted: MountedStats[] = [];

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		for (const root of mounted) root.dispose();
		mounted.length = 0;
		vi.useRealTimers();
	});

	it("holds the last snapshot when a malformed report throws, then keeps polling", async () => {
		let report = makeReport([
			inboundVideo({ bytesReceived: 0, timestamp: 10_000 }),
			vp9Codec,
		]);
		const getRTCStatsReport = vi.fn(async () => report);
		const root = mountStats(() => statsTrack(getRTCStatsReport));
		mounted.push(root);

		await vi.advanceTimersByTimeAsync(0);
		const first = root.snapshot();
		expect(first).toMatchObject({
			frameWidth: 2560,
			frameHeight: 1440,
			framesPerSecond: 60,
			codec: "VP9",
			bitrate: null,
		});

		report = {
			forEach: () => {
				throw new TypeError("broken stats iterator");
			},
		} as unknown as RTCStatsReport;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(root.snapshot()).toBe(first);

		report = makeReport([
			inboundVideo({
				frameWidth: 1280,
				frameHeight: 720,
				bytesReceived: 125_000,
				timestamp: 11_000,
			}),
			vp9Codec,
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(root.snapshot()).toMatchObject({
			frameWidth: 1280,
			frameHeight: 720,
			bitrate: 1_000_000,
		});
		expect(getRTCStatsReport).toHaveBeenCalledTimes(3);
	});

	it("backs off after synchronous, rejected, and absent reports, then recovers", async () => {
		let recovered = false;
		const getRTCStatsReport = vi.fn(() => {
			if (recovered) {
				return Promise.resolve(
					makeReport([inboundVideo({ framesPerSecond: undefined }), vp9Codec]),
				);
			}
			const call = getRTCStatsReport.mock.calls.length;
			if (call === 1) throw new DOMException("receiver closed");
			if (call === 2) return Promise.reject(new TypeError("getStats failed"));
			return Promise.resolve(undefined);
		});
		const root = mountStats(() => statsTrack(getRTCStatsReport));
		mounted.push(root);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(root.snapshot()).toBeNull();
		expect(getRTCStatsReport).toHaveBeenCalledTimes(3);

		recovered = true;
		await vi.advanceTimersByTimeAsync(1_999);
		expect(getRTCStatsReport).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(getRTCStatsReport).toHaveBeenCalledTimes(4);
		expect(root.snapshot()).toMatchObject({
			frameWidth: 2560,
			frameHeight: 1440,
			framesPerSecond: null,
			bitrate: null,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		expect(getRTCStatsReport).toHaveBeenCalledTimes(5);
	});

	it("ignores a stats request that settles after the track is replaced", async () => {
		let resolveFirst!: (report: RTCStatsReport) => void;
		const firstReport = new Promise<RTCStatsReport>((resolve) => {
			resolveFirst = resolve;
		});
		const firstGetter = vi.fn(() => firstReport);
		const secondGetter = vi.fn(async () =>
			makeReport([
				inboundVideo({ frameWidth: 1920, frameHeight: 1080 }),
				vp9Codec,
			]),
		);
		const [track, setTrack]: [
			Accessor<RemoteVideoTrack>,
			Setter<RemoteVideoTrack>,
		] = createSignal(statsTrack(firstGetter));
		const root = mountStats(track);
		mounted.push(root);

		await vi.advanceTimersByTimeAsync(0);
		expect(firstGetter).toHaveBeenCalledTimes(1);

		setTrack(statsTrack(secondGetter));
		await vi.advanceTimersByTimeAsync(0);
		expect(root.snapshot()).toMatchObject({
			frameWidth: 1920,
			frameHeight: 1080,
		});

		resolveFirst(
			makeReport([
				inboundVideo({ frameWidth: 640, frameHeight: 360 }),
				vp9Codec,
			]),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(root.snapshot()).toMatchObject({
			frameWidth: 1920,
			frameHeight: 1080,
		});

		await vi.advanceTimersByTimeAsync(2_000);
		expect(firstGetter).toHaveBeenCalledTimes(1);
		expect(secondGetter).toHaveBeenCalledTimes(3);
	});
});
