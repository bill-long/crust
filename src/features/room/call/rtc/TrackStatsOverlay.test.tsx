import { cleanup, render, screen } from "@solidjs/testing-library";
import type { RemoteVideoTrack } from "livekit-client";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateSetting } from "../../../../stores/settings";
import { TrackStatsOverlay } from "./TrackStatsOverlay";
import {
	inboundVideo,
	makeFakeStatsTrack,
	outboundVideo,
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
		// The stats gate is enforced inside the component; the badge
		// behavior under test requires it open.
		updateSetting("rtcShowCallStats", true);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		updateSetting("rtcShowCallStats", false);
	});

	it("fails closed: no badge and no polling when the setting is off or the participant is unresolved", async () => {
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

	it("treats a send-side layer flip as the same publication (spell and bitrate continue)", async () => {
		// Two simulcast layers; which one is ACTIVE (has fps) flips between
		// ticks. Each entry has its own cumulative limitation clock.
		const layers = (
			activeId: "out-a" | "out-b",
			bytesA: number,
			bytesB: number,
			ts: number,
			cpuA: number,
			cpuB: number,
		): Record<string, unknown>[] => [
			outboundVideo({
				id: "out-a",
				framesPerSecond: activeId === "out-a" ? 30 : undefined,
				bytesSent: bytesA,
				timestamp: ts,
				qualityLimitationReason: "bandwidth",
				qualityLimitationDurations: { bandwidth: cpuA },
			}),
			outboundVideo({
				id: "out-b",
				frameWidth: 640,
				frameHeight: 360,
				framesPerSecond: activeId === "out-b" ? 30 : undefined,
				bytesSent: bytesB,
				timestamp: ts,
				qualityLimitationReason: "bandwidth",
				qualityLimitationDurations: { bandwidth: cpuB },
			}),
			vp9Codec,
		];
		const fake = makeFakeStatsTrack({
			statsEntries: layers("out-a", 0, 0, 10_000, 5, 50),
		});
		render(() => <TrackStatsOverlay isLocal={true} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		// Spell starts on out-a's clock (base 5).
		fake.setStatsEntries(layers("out-a", 200_000, 50_000, 11_000, 7, 52));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain("2.0 Mbps");
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"bandwidth limited · 2s",
		);

		// The active layer flips to out-b (different cumulative clock): the
		// bitrate keeps measuring (same byte population) and the spell keeps
		// its elapsed time instead of resetting.
		fake.setStatsEntries(layers("out-b", 300_000, 200_000, 12_000, 7, 54));
		await vi.advanceTimersByTimeAsync(1_000);
		const flipped = screen.getByTestId("track-stats").textContent ?? "";
		expect(flipped).toContain("2.0 Mbps");
		expect(flipped).toContain("bandwidth limited · 2s");

		// And it continues accumulating on the new clock.
		fake.setStatsEntries(layers("out-b", 400_000, 350_000, 13_000, 7, 57));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"bandwidth limited · 5s",
		);
	});

	it("keeps fps honest across a send republication (per-entry fps, spell continuity by contract)", async () => {
		const fake = makeFakeStatsTrack({
			statsEntries: [
				outboundVideo({
					id: "out-1",
					bytesSent: 0,
					timestamp: 10_000,
					qualityLimitationReason: "cpu",
					qualityLimitationDurations: { cpu: 30 },
				}),
				vp9Codec,
			],
		});
		render(() => <TrackStatsOverlay isLocal={true} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByTestId("track-stats").textContent).toContain("60fps");

		// A reconnect republishes the track; the transitional report still
		// lists the ended entry next to the new one. fps history is
		// per-entry, so the fresh encoder's first second (no fps yet) must
		// not read as a 0fps stall; the limitation spell carries by
		// contract (the restart did not lift the condition) - here its
		// elapsed time is 0, so no duration segment renders.
		fake.setStatsEntries([
			outboundVideo({
				id: "out-1",
				active: false,
				framesPerSecond: undefined,
				bytesSent: 0,
				timestamp: 10_000,
				qualityLimitationReason: "cpu",
				qualityLimitationDurations: { cpu: 30 },
			}),
			outboundVideo({
				id: "out-new",
				framesPerSecond: undefined,
				bytesSent: 0,
				timestamp: 11_000,
				qualityLimitationReason: "cpu",
				qualityLimitationDurations: { cpu: 0.2 },
			}),
			vp9Codec,
		]);
		await vi.advanceTimersByTimeAsync(1_000);
		const text = screen.getByTestId("track-stats").textContent ?? "";
		expect(text).toContain("1920x1080");
		expect(text).not.toContain("fps");
		// New spell on the new stream: no inherited duration segment.
		expect(text).toContain("cpu limited");
		expect(text).not.toMatch(/limited · \d+s/);
	});

	it("carries a nonzero limitation spell across a send republication", async () => {
		const entry = (
			id: string,
			ts: number,
			cpu: number,
		): Record<string, unknown>[] => [
			outboundVideo({
				id,
				bytesSent: 0,
				timestamp: ts,
				qualityLimitationReason: "cpu",
				qualityLimitationDurations: { cpu },
			}),
			vp9Codec,
		];
		const fake = makeFakeStatsTrack({
			statsEntries: entry("out-1", 10_000, 5),
		});
		render(() => <TrackStatsOverlay isLocal={true} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		fake.setStatsEntries(entry("out-1", 12_000, 8));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"cpu limited · 3s",
		);

		// Republication: new entry id with its own (young) cumulative clock.
		// The limitation didn't lift, so the spell continues from 3s.
		fake.setStatsEntries(entry("out-new", 13_000, 0.5));
		await vi.advanceTimersByTimeAsync(1_000);
		fake.setStatsEntries(entry("out-new", 14_000, 1.5));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"cpu limited · 4s",
		);
	});

	it("holds the readout across a ~3s jank gap, re-baselining only the measurements", async () => {
		const entries = (bytes: number, ts: number, cpu: number) => [
			outboundVideo({
				bytesSent: bytes,
				timestamp: ts,
				qualityLimitationReason: "cpu",
				qualityLimitationDurations: { cpu },
			}),
			vp9Codec,
		];
		const fake = makeFakeStatsTrack({ statsEntries: entries(0, 10_000, 10) });
		render(() => <TrackStatsOverlay isLocal={true} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		fake.setStatsEntries(entries(250_000, 11_000, 12));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain("2.0 Mbps");
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"cpu limited · 2s",
		);

		// A main-thread hiccup delays the next tick ~3s: the badge must NOT
		// blank or reset the spell (the cumulative clock is gap-immune);
		// only the byte baseline re-measures.
		vi.setSystemTime(Date.now() + 3_000);
		fake.setStatsEntries(entries(1_000_000, 14_000, 15));
		await vi.advanceTimersByTimeAsync(1_000);
		const text = screen.getByTestId("track-stats").textContent ?? "";
		expect(text).toContain("1920x1080");
		expect(text).toContain("cpu limited · 5s");
		expect(text).not.toContain("Mbps");
		// Measurement resumes on the following tick.
		fake.setStatsEntries(entries(1_250_000, 15_000, 16));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain("2.0 Mbps");
	});

	it("preserves the limitation spell across a flip that follows a held tick", async () => {
		const layers = (
			activeId: "out-a" | "out-b",
			ts: number,
			cpuA: number,
			cpuB: number,
		): Record<string, unknown>[] => [
			outboundVideo({
				id: "out-a",
				framesPerSecond: activeId === "out-a" ? 30 : undefined,
				timestamp: ts,
				qualityLimitationReason: "cpu",
				qualityLimitationDurations: { cpu: cpuA },
			}),
			outboundVideo({
				id: "out-b",
				frameWidth: 640,
				frameHeight: 360,
				framesPerSecond: activeId === "out-b" ? 30 : undefined,
				timestamp: ts,
				qualityLimitationReason: "cpu",
				qualityLimitationDurations: { cpu: cpuB },
			}),
			vp9Codec,
		];
		const fake = makeFakeStatsTrack({
			statsEntries: layers("out-a", 10_000, 5, 40),
		});
		render(() => <TrackStatsOverlay isLocal={true} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		fake.setStatsEntries(layers("out-a", 11_000, 8, 43));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"cpu limited · 3s",
		);

		// One held tick decays the warning's "now" claim...
		fake.setReportUnavailable(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).not.toContain(
			"limited",
		);
		fake.setReportUnavailable(false);

		// ...then the active layer flips. The spell's elapsed time is carried
		// from poller state, NOT the decayed snapshot - it must resume, not
		// restart at zero.
		fake.setStatsEntries(layers("out-b", 13_000, 8, 45));
		await vi.advanceTimersByTimeAsync(1_000);
		fake.setStatsEntries(layers("out-b", 14_000, 8, 47));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"cpu limited · 5s",
		);
	});

	it("discards stale baselines when the tick chain itself was stalled (hidden tab)", async () => {
		const fake = makeFakeStatsTrack({
			statsEntries: [inboundVideo(), vp9Codec],
		});
		render(() => <TrackStatsOverlay isLocal={false} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByTestId("track-stats")).toBeTruthy();

		// The tab is hidden and timers are throttled: no ticks run for two
		// minutes while counters grow, then the overdue tick finally fires.
		vi.setSystemTime(Date.now() + 120_000);
		fake.setStatsEntries([inboundVideo({ framesDropped: 900 }), vp9Codec]);
		await vi.advanceTimersByTimeAsync(1_000);
		const text = screen.getByTestId("track-stats").textContent ?? "";
		// Gap-era drops are a fresh baseline, not a live warning, and no
		// gap-averaged bitrate renders.
		expect(text).toContain("2560x1440");
		expect(text).not.toContain("dropped");
	});

	it("remounts the badge with the new direction if isLocal ever flips while mounted", async () => {
		const fake = makeFakeStatsTrack({
			statsEntries: [inboundVideo(), vp9Codec],
		});
		const [isLocal, setIsLocal] = createSignal<boolean | undefined>(false);
		render(() => <TrackStatsOverlay isLocal={isLocal()} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"2560x1440",
		);

		// isLocal corrects to true without an undefined interlude: the keyed
		// gate remounts the badge on the send direction, which finds no
		// outbound entries in this report - never a stale receive readout.
		setIsLocal(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"no frames sent",
		);
	});

	it("renders send-side stats with the encoder's live limitation as a current spell", async () => {
		const sending = (
			bytes: number,
			ts: number,
			reason: string,
			cpuSecs: number,
		): Record<string, unknown>[] => [
			outboundVideo({
				bytesSent: bytes,
				timestamp: ts,
				qualityLimitationReason: reason,
				qualityLimitationDurations: { none: 3, cpu: cpuSecs, bandwidth: 0 },
			}),
			vp9Codec,
		];
		const fake = makeFakeStatsTrack({
			statsEntries: sending(0, 10_000, "none", 12),
		});
		render(() => <TrackStatsOverlay isLocal={true} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		const initial = screen.getByTestId("track-stats").textContent ?? "";
		expect(initial).toContain("1920x1080 · 60fps");
		expect(initial).not.toContain("limited");

		// 1,500,000 bytes over 1s -> 12 Mbps total upload; the encoder now
		// self-reports a cpu limitation. The 12 CUMULATIVE seconds are from
		// an earlier spell - a just-started limitation shows no duration.
		fake.setStatsEntries(sending(1_500_000, 11_000, "cpu", 12));
		await vi.advanceTimersByTimeAsync(1_000);
		const limited = screen.getByTestId("track-stats").textContent ?? "";
		expect(limited).toContain("12.0 Mbps · VP9");
		expect(limited).toContain("cpu limited");
		expect(limited).not.toContain("12s");

		// The spell continues: duration reflects growth since ITS start.
		fake.setStatsEntries(sending(3_000_000, 12_000, "cpu", 15));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"cpu limited · 3s",
		);

		// A held (missing-report) tick decays the limitation's "now" claim
		// while the rest of the readout holds.
		fake.setReportUnavailable(true);
		await vi.advanceTimersByTimeAsync(1_000);
		const held = screen.getByTestId("track-stats").textContent ?? "";
		expect(held).toContain("1920x1080");
		expect(held).not.toContain("limited");
		fake.setReportUnavailable(false);

		// Back to unlimited: the warning stays cleared on fresh reports.
		fake.setStatsEntries(sending(4_000_000, 14_000, "none", 15));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).not.toContain(
			"limited",
		);
	});

	it("re-baselines the upload bitrate when a lower simulcast layer churns", async () => {
		const layers = (
			lowId: string,
			lowBytes: number,
			topBytes: number,
			ts: number,
		): Record<string, unknown>[] => [
			outboundVideo({ id: "out-top", bytesSent: topBytes, timestamp: ts }),
			outboundVideo({
				id: lowId,
				frameWidth: 640,
				frameHeight: 360,
				framesPerSecond: 30,
				bytesSent: lowBytes,
				timestamp: ts,
			}),
			vp9Codec,
		];
		const fake = makeFakeStatsTrack({
			statsEntries: layers("out-low", 500_000, 0, 10_000),
		});
		render(() => <TrackStatsOverlay isLocal={true} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		fake.setStatsEntries(layers("out-low", 750_000, 0, 11_000));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain("2.0 Mbps");

		// The lower layer's entry is replaced (SSRC restart): the summed
		// byte population changed, so the rate is unmeasured for one tick -
		// never a spike from the doubled sum or a blank from it collapsing.
		fake.setStatsEntries(layers("out-low2", 1_000, 0, 12_000));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).not.toContain("bps");
		// The new population measures normally on the next tick.
		fake.setStatsEntries(layers("out-low2", 251_000, 0, 13_000));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(screen.getByTestId("track-stats").textContent).toContain("2.0 Mbps");
	});

	it("says 'no frames sent' when the local encoder hasn't produced frames", async () => {
		const fake = makeFakeStatsTrack({
			statsEntries: [
				outboundVideo({
					frameWidth: undefined,
					frameHeight: undefined,
					framesPerSecond: undefined,
				}),
				vp9Codec,
			],
		});
		render(() => <TrackStatsOverlay isLocal={true} track={fake.track} />);
		await vi.advanceTimersByTimeAsync(0);
		expect(screen.getByTestId("track-stats").textContent).toContain(
			"no frames sent",
		);
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
