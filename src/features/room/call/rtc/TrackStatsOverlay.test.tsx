import { cleanup, render, screen } from "@solidjs/testing-library";
import type { RemoteVideoTrack } from "livekit-client";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSetting } from "../../../../stores/settings";
import { TrackStatsOverlay } from "./TrackStatsOverlay";
import {
	inboundVideo,
	makeFakeStatsTrack,
	vp9Codec,
} from "./trackStats.test-utils";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

describe("TrackStatsOverlay", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// The receive-stats gate is enforced inside the component; the badge
		// behavior under test requires it open.
		updateSetting("rtcShowCallStats", true);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		updateSetting("rtcShowCallStats", false);
	});

	it("fails closed: no badge and no polling when the setting is off or isLocal is not exactly false", async () => {
		updateSetting("rtcShowCallStats", false);
		const gatedBySetting = makeFakeStatsTrack({
			statsEntries: [inboundVideo(), vp9Codec],
		});
		const r1 = render(() => (
			<TrackStatsOverlay isLocal={false} track={gatedBySetting.track} />
		));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(screen.queryByTestId("track-stats")).toBeNull();
		expect(gatedBySetting.getRTCStatsReport).not.toHaveBeenCalled();
		r1.unmount();

		updateSetting("rtcShowCallStats", true);
		const unresolved = makeFakeStatsTrack({
			statsEntries: [inboundVideo(), vp9Codec],
		});
		render(() => (
			<TrackStatsOverlay isLocal={undefined} track={unresolved.track} />
		));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(screen.queryByTestId("track-stats")).toBeNull();
		expect(unresolved.getRTCStatsReport).not.toHaveBeenCalled();
	});

	it("renders resolution, fps, codec, and a delta-derived bitrate", async () => {
		const fake = makeFakeStatsTrack({
			statsEntries: [
				inboundVideo({
					powerEfficientDecoder: true,
					bytesReceived: 0,
					timestamp: 10_000,
				}),
				vp9Codec,
			],
		});
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		const badge = screen.getByTestId("track-stats");
		expect(badge.textContent).toContain("2560x1440 · 60fps");
		// First tick has no delta baseline: codec shown, no bitrate number.
		expect(badge.textContent).toContain("VP9 hw");
		expect(badge.textContent).not.toContain("bps");

		// 992,500 bytes over 1s -> 7.9 Mbps.
		fake.setStatsEntries([
			inboundVideo({
				powerEfficientDecoder: true,
				bytesReceived: 992_500,
				timestamp: 11_000,
			}),
			vp9Codec,
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"7.9 Mbps · VP9 hw",
		);
	});

	it("shows the anomaly line only while counters are actively increasing", async () => {
		const fake = makeFakeStatsTrack({
			statsEntries: [inboundVideo(), vp9Codec],
		});
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByTestId("track-stats").textContent).not.toContain(
			"dropped",
		);

		// Counters increase -> the warning line appears with the totals.
		fake.setStatsEntries([
			inboundVideo({ framesDropped: 12, freezeCount: 1 }),
			vp9Codec,
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"12 dropped · 1 freeze",
		);

		// Counters hold steady (the blip is over) -> the warning line clears,
		// even though the cumulative totals remain nonzero.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).not.toContain(
			"dropped",
		);

		// While a held (miss) tick freezes the rest of the readout, the
		// warning's "happening NOW" claim decays immediately.
		fake.setStatsEntries([
			inboundVideo({ framesDropped: 30, freezeCount: 2 }),
			vp9Codec,
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"30 dropped",
		);
		fake.setReportUnavailable(true);
		await vi.advanceTimersByTimeAsync(1_000);
		const held = screen.getByTestId("track-stats").textContent ?? "";
		expect(held).toContain("2560x1440");
		expect(held).not.toContain("dropped");

		// Counters rose DURING the gap: the recovery tick re-baselines rather
		// than claiming gap-era drops are happening now...
		fake.setStatsEntries([
			inboundVideo({ framesDropped: 60, freezeCount: 2 }),
			vp9Codec,
		]);
		fake.setReportUnavailable(false);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).not.toContain(
			"dropped",
		);
		// ...while a live increase after recovery warns again.
		fake.setStatsEntries([
			inboundVideo({ framesDropped: 75, freezeCount: 2 }),
			vp9Codec,
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"75 dropped",
		);
	});

	it("carries an active anomaly warning across a cached (same-timestamp) report", async () => {
		const entries = (
			dropped: number,
			ts: number,
		): Record<string, unknown>[] => [
			inboundVideo({ framesDropped: dropped, bytesReceived: 0, timestamp: ts }),
			vp9Codec,
		];
		const fake = makeFakeStatsTrack({ statsEntries: entries(0, 10_000) });
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		fake.setStatsEntries(entries(12, 11_000));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"12 dropped",
		);

		// The browser serves the SAME measurement window again: the warning
		// must not blink off for a tick mid-problem.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"12 dropped",
		);

		// A genuinely fresh report with flat counters clears it.
		fake.setStatsEntries(entries(12, 12_000));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).not.toContain(
			"dropped",
		);
	});

	it("reports 0fps when a previously decoding stream stalls, but omits fps during the first unmeasured second", async () => {
		// framesPerSecond absent from the start: a new stream's first second,
		// not a stall - no fps segment, and definitely no false "0fps".
		const fake = makeFakeStatsTrack({
			statsEntries: [inboundVideo({ framesPerSecond: undefined }), vp9Codec],
		});
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		const initial = screen.getByTestId("track-stats").textContent ?? "";
		expect(initial).toContain("2560x1440");
		expect(initial).not.toContain("fps");

		// The stream measures a rate, then stalls: NOW a missing
		// framesPerSecond renders as an honest 0fps.
		fake.setStatsEntries([inboundVideo(), vp9Codec]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain("60fps");
		fake.setStatsEntries([
			inboundVideo({ framesPerSecond: undefined }),
			vp9Codec,
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"2560x1440 · 0fps",
		);
	});

	it("says 'no frames decoded' (and nothing fabricated) when the report has no inbound video entry", async () => {
		const fake = makeFakeStatsTrack({ statsEntries: [] });
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		const badge = screen.getByTestId("track-stats");
		expect(badge.textContent).toContain("no frames decoded");
		// No entry -> nothing measured -> no rate segment at all.
		expect(badge.textContent).not.toContain("bps");
	});

	it("says 'no frames decoded' with codec and measured bitrate when RTP flows but never decodes", async () => {
		const noFrames = (bytes: number, ts: number): Record<string, unknown>[] => [
			inboundVideo({
				frameWidth: undefined,
				frameHeight: undefined,
				framesPerSecond: undefined,
				bytesReceived: bytes,
				timestamp: ts,
			}),
			vp9Codec,
		];
		const fake = makeFakeStatsTrack({ statsEntries: noFrames(0, 10_000) });
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		// 525,000 bytes over 1s -> 4.2 Mbps: "arriving but not decoding",
		// distinguishable from "nothing arriving" (a measured 0 kbps).
		fake.setStatsEntries(noFrames(525_000, 11_000));
		await vi.advanceTimersByTimeAsync(1_000);
		const badge = screen.getByTestId("track-stats");
		expect(badge.textContent).toContain("no frames decoded");
		expect(badge.textContent).toContain("4.2 Mbps · VP9");
	});

	it("backs off to the recovery cadence on a dead stats surface and recovers when it returns", async () => {
		const fake = makeFakeStatsTrack({ reportUnavailable: true });
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		// Misses at t=0/1s/2s reach MAX_MISSING_REPORTS; the next poll is on
		// the 10s recovery cadence, so t=10s has seen exactly 3 calls.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(screen.queryByTestId("track-stats")).toBeNull();
		expect(fake.getRTCStatsReport).toHaveBeenCalledTimes(3);

		// The surface comes back (same track object) carrying a FRESH stream
		// whose fps isn't measured yet: the next recovery poll finds it, the
		// badge returns treating it as a new stream (no false "0fps" stall
		// from stale sawFps, no anomaly warning from a stale counter
		// baseline), and fast polling resumes.
		fake.setReportUnavailable(false);
		fake.setStatsEntries([
			inboundVideo({ framesPerSecond: undefined, framesDropped: 50 }),
			vp9Codec,
		]);
		await vi.advanceTimersByTimeAsync(10_000);
		const recovered = screen.getByTestId("track-stats").textContent ?? "";
		expect(recovered).toContain("2560x1440");
		expect(recovered).not.toContain("fps");
		expect(recovered).not.toContain("dropped");
		const calls = fake.getRTCStatsReport.mock.calls.length;
		await vi.advanceTimersByTimeAsync(2_000);
		expect(fake.getRTCStatsReport.mock.calls.length).toBe(calls + 2);
	});

	it("holds the last-good readout when the inbound entry vanishes transiently from a live report", async () => {
		const fake = makeFakeStatsTrack({
			statsEntries: [inboundVideo(), vp9Codec],
		});
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"2560x1440 · 60fps",
		);

		// Report still arrives but the inbound-rtp entry is gone for one tick
		// (renegotiation / layer switch): no "no frames decoded" flicker.
		fake.setStatsEntries([]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"2560x1440 · 60fps",
		);

		fake.setStatsEntries([inboundVideo(), vp9Codec]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"2560x1440 · 60fps",
		);

		// If the entry stays gone past the hold window, the badge settles on
		// the honest "no frames decoded" state - and polling stays at the
		// fast cadence, because the stats surface itself is alive.
		fake.setStatsEntries([]);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"no frames decoded",
		);
		const calls = fake.getRTCStatsReport.mock.calls.length;
		await vi.advanceTimersByTimeAsync(2_000);
		expect(fake.getRTCStatsReport.mock.calls.length).toBe(calls + 2);
	});

	it("resets per-stream state when the inbound entry id changes (stream replaced)", async () => {
		const fake = makeFakeStatsTrack({
			statsEntries: [inboundVideo(), vp9Codec],
		});
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByTestId("track-stats").textContent).toContain("60fps");

		// A new inbound entry (SSRC restart): its unmeasured first second must
		// not read as a stall via stale sawFps, and its counters must not be
		// compared against the old stream's baseline.
		fake.setStatsEntries([
			inboundVideo({
				id: "in-2",
				framesPerSecond: undefined,
				framesDropped: 40,
			}),
			vp9Codec,
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		const text = screen.getByTestId("track-stats").textContent ?? "";
		expect(text).toContain("2560x1440");
		expect(text).not.toContain("fps");
		expect(text).not.toContain("dropped");
	});

	it("holds the last-good readout across a transient stats miss instead of flickering", async () => {
		const fake = makeFakeStatsTrack({
			statsEntries: [inboundVideo(), vp9Codec],
		});
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"2560x1440",
		);

		// One transient miss: the badge must not blank.
		fake.setReportUnavailable(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"2560x1440",
		);

		// Recovery resets the miss counter and keeps updating.
		fake.setReportUnavailable(false);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats")).toBeTruthy();

		// A permanent-looking run of misses clears the badge and drops to the
		// 10s recovery cadence (so no further calls land within 5s).
		fake.setReportUnavailable(true);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(screen.queryByTestId("track-stats")).toBeNull();
		const calls = fake.getRTCStatsReport.mock.calls.length;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fake.getRTCStatsReport).toHaveBeenCalledTimes(calls);
	});

	it("survives a track without stats APIs (partial test fakes, teardown)", async () => {
		// The overlay's only track surface is getRTCStatsReport; its absence
		// is exactly the contract under test.
		const bare = {} as unknown as RemoteVideoTrack;
		render(() => <TrackStatsOverlay isLocal={false} track={bare} />);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.queryByTestId("track-stats")).toBeNull();
	});

	it("keeps its readout and baselines across a remount with the same track", async () => {
		const fake = makeFakeStatsTrack({
			statsEntries: [
				inboundVideo({ bytesReceived: 0, timestamp: 10_000 }),
				vp9Codec,
			],
		});
		const first = render(() => (
			<TrackStatsOverlay isLocal={false} track={fake.track} />
		));
		await vi.advanceTimersByTimeAsync(0);
		fake.setStatsEntries([
			inboundVideo({ bytesReceived: 992_500, timestamp: 11_000 }),
			vp9Codec,
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain("7.9 Mbps");

		// Tile rebuild (e.g. a speaking flip remounts the whole tile): the
		// badge must re-render its last readout IMMEDIATELY, without waiting
		// for a poll, and keep its measurement baselines.
		first.unmount();
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		expect(screen.getByTestId("track-stats").textContent).toContain("7.9 Mbps");
	});

	it("preserves an actively-measured anomaly warning across a quick remount (no blink)", async () => {
		const fake = makeFakeStatsTrack({
			statsEntries: [inboundVideo(), vp9Codec],
		});
		const first = render(() => (
			<TrackStatsOverlay isLocal={false} track={fake.track} />
		));
		await vi.advanceTimersByTimeAsync(0);
		fake.setStatsEntries([
			inboundVideo({ framesDropped: 12, freezeCount: 1 }),
			vp9Codec,
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"12 dropped",
		);

		// A speaking-flip tile rebuild during an ONGOING problem: the warning
		// (measured within the fresh window) must not blink off.
		first.unmount();
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		const remounted = screen.getByTestId("track-stats").textContent ?? "";
		expect(remounted).toContain("2560x1440");
		expect(remounted).toContain("12 dropped");
	});

	it("keeps the recovery backoff across a tile remount on a dead stats surface", async () => {
		const fake = makeFakeStatsTrack({ reportUnavailable: true });
		const first = render(() => (
			<TrackStatsOverlay isLocal={false} track={fake.track} />
		));
		// 3 misses at t=0/1s/2s declare the surface dead and back off to 10s.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fake.getRTCStatsReport).toHaveBeenCalledTimes(3);

		// A remount 5s into the recovery window must not reset the backoff
		// (its cadence is 10s, so the state is fresh by its OWN cadence) and
		// must not fire an immediate probe either - constant tile rebuilds
		// would otherwise re-hammer the dead surface at full speed. The next
		// probe lands one recovery interval after the remount.
		first.unmount();
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fake.getRTCStatsReport).toHaveBeenCalledTimes(3);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fake.getRTCStatsReport).toHaveBeenCalledTimes(4);
	});

	it("discards stale persisted state after a long unmounted gap", async () => {
		const fake = makeFakeStatsTrack({
			statsEntries: [inboundVideo(), vp9Codec],
		});
		const first = render(() => (
			<TrackStatsOverlay isLocal={false} track={fake.track} />
		));
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByTestId("track-stats")).toBeTruthy();
		first.unmount();

		// Minutes pass with the badge unmounted (e.g. the setting was off)
		// while counters grow.
		await vi.advanceTimersByTimeAsync(60_000);
		fake.setStatsEntries([inboundVideo({ framesDropped: 500 }), vp9Codec]);
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		// No instant resurrection of the minutes-old readout...
		expect(screen.queryByTestId("track-stats")).toBeNull();
		await vi.advanceTimersByTimeAsync(0);
		const text = screen.getByTestId("track-stats").textContent ?? "";
		expect(text).toContain("2560x1440");
		// ...and the gap-era drops are a fresh baseline, not "happening now".
		expect(text).not.toContain("dropped");
	});

	it("re-baselines on a byte-counter reset instead of reporting a false 0 kbps", async () => {
		const grow = (bytes: number, ts: number): Record<string, unknown>[] => [
			inboundVideo({ bytesReceived: bytes, timestamp: ts }),
			vp9Codec,
		];
		const fake = makeFakeStatsTrack({ statsEntries: grow(0, 10_000) });
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		fake.setStatsEntries(grow(992_500, 11_000));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain("7.9 Mbps");

		// Counter went backwards (receiver-internal reset): unmeasured for a
		// tick - neither the stale rate nor a fabricated measured zero.
		fake.setStatsEntries(grow(1_000, 12_000));
		await vi.advanceTimersByTimeAsync(1_000);
		const text = screen.getByTestId("track-stats").textContent ?? "";
		expect(text).not.toContain("bps");
		// The fresh baseline measures normally on the next tick.
		fake.setStatsEntries(grow(126_000, 13_000));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain("1.0 Mbps");
	});

	it("carries the measured bitrate across a cached (same-timestamp) report", async () => {
		const fake = makeFakeStatsTrack({
			statsEntries: [
				inboundVideo({ bytesReceived: 0, timestamp: 10_000 }),
				vp9Codec,
			],
		});
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		fake.setStatsEntries([
			inboundVideo({ bytesReceived: 992_500, timestamp: 11_000 }),
			vp9Codec,
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain("7.9 Mbps");

		// Same measurement window served again: the number must not blink out.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain("7.9 Mbps");
	});

	it("polls once per second, resets on track replacement, and stops on unmount", async () => {
		const first = makeFakeStatsTrack({
			statsEntries: [inboundVideo(), vp9Codec],
		});
		const second = makeFakeStatsTrack({
			statsEntries: [
				inboundVideo({ frameWidth: 1920, frameHeight: 1080 }),
				vp9Codec,
			],
		});
		const [track, setTrack] = createSignal(first.track);
		const result = render(() => (
			<TrackStatsOverlay isLocal={false} track={track()} />
		));
		await vi.advanceTimersByTimeAsync(2_000);
		// Initial tick + one per interval.
		expect(first.getRTCStatsReport).toHaveBeenCalledTimes(3);

		setTrack(second.track);
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"1920x1080",
		);
		const firstCalls = first.getRTCStatsReport.mock.calls.length;
		await vi.advanceTimersByTimeAsync(2_000);
		// The replaced track's interval was torn down with the effect.
		expect(first.getRTCStatsReport).toHaveBeenCalledTimes(firstCalls);
		expect(second.getRTCStatsReport.mock.calls.length).toBeGreaterThan(1);

		result.unmount();
		const secondCalls = second.getRTCStatsReport.mock.calls.length;
		await vi.advanceTimersByTimeAsync(3_000);
		expect(second.getRTCStatsReport).toHaveBeenCalledTimes(secondCalls);
	});
});
