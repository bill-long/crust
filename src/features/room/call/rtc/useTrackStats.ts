import type { LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import {
	type Accessor,
	createEffect,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import { type InboundVideoStats, readInboundVideoStats } from "./trackStats";

/** How often the readout refreshes while a consumer is mounted. */
const POLL_INTERVAL_MS = 1_000;

/**
 * Consecutive missing stats reports after which the readout clears and
 * polling drops to the recovery cadence. Missing reports are usually
 * permanent (browser without receiver stats), but can be a transient
 * outage on a surviving track (getStats rejecting during renegotiation),
 * so polling slows down instead of stopping - a dead end costs one call
 * per RECOVERY_POLL_INTERVAL_MS instead of one per second, while a
 * recovered surface brings the readout back on its own.
 */
const MAX_MISSING_REPORTS = 3;

/** Poll cadence while the stats surface looks dead (see above). */
const RECOVERY_POLL_INTERVAL_MS = 10_000;

/**
 * Persisted per-track state is discarded on mount once older than this
 * many missed ticks of ITS OWN cadence (fast or recovery). The
 * persistence exists for near-instant remounts (a tile rebuild on a
 * speaking flip); after a real gap (the setting was off, the tile was
 * gone) the baselines would render gap-era drops and gap-averaged
 * bitrates as current, and the snapshot itself is stale news. Measuring
 * against the state's own cadence keeps the recovery backoff alive
 * across remounts - a slow-polling dead surface ticks only every
 * RECOVERY_POLL_INTERVAL_MS, and resetting it on each tile rebuild
 * would re-probe the dead end at full speed all call long.
 */
const STALE_TICKS = 2;

/**
 * The fields the stats badge renders: the parsed stats minus the
 * poll-loop-only fields (`entryId` and the raw byte/timestamp counters
 * must not leak into render state), plus the two values the loop derives.
 */
export interface StatsSnapshot
	extends Omit<InboundVideoStats, "entryId" | "bytesReceived" | "timestamp"> {
	/**
	 * Receive bitrate in bits/sec, derived from tick-to-tick
	 * bytesReceived deltas. Null until a delta baseline exists (a
	 * stream's first tick), which renders as no number rather than a
	 * false "0 kbps".
	 */
	bitrate: number | null;
	/**
	 * True when the drop/freeze counters increased during the last poll
	 * interval. The counters themselves are cumulative since subscription,
	 * so this is what makes the warning line mean "happening NOW" rather
	 * than "happened at some point in this call".
	 */
	anomaliesActive: boolean;
}

type StatsTrack = LocalVideoTrack | RemoteVideoTrack;

/**
 * Poll/measurement state for one track. Kept OUTSIDE the consuming
 * component, weakly keyed on the track object, because the call grid's
 * reference-keyed `<For>` lists rebuild tiles on unrelated events (a
 * speaking flip, another participant starting a share): a remounted
 * badge must resume from these baselines - and re-render the last
 * readout immediately - rather than blanking and re-measuring.
 */
interface TrackStatsState {
	/**
	 * Whether framesPerSecond has ever been reported for the CURRENT
	 * stream. Distinguishes "not measured yet" (first second - omit the
	 * fps segment) from "measured before, absent now" (a stall - 0fps).
	 */
	sawFps: boolean;
	/**
	 * Previous tick's cumulative counters, so the warning line only shows
	 * while they're actively increasing.
	 */
	lastCounters: { dropped: number; freezes: number } | null;
	/** Previous tick's byte counter + timestamp: the bitrate delta baseline. */
	lastBytes: { bytes: number; timestamp: number } | null;
	/** Last measured bitrate, carried across cached (same-timestamp) reports. */
	lastBitrate: number | null;
	/** Which inbound-rtp entry the per-stream state above belongs to. */
	lastEntryId: string | null;
	/** Consecutive ticks whose report was missing entirely. */
	missingReports: number;
	/**
	 * Consecutive live reports whose inbound-rtp entry was missing after
	 * previously being present. Tracked separately from missingReports: a
	 * vanished ENTRY on a live surface must never slow polling down - it
	 * settles on the honest "no frames decoded" state at full cadence.
	 */
	entryMissing: number;
	/** Whether polling is currently on the recovery cadence. */
	slowPolling: boolean;
	/** The last published readout, re-rendered instantly on remount. */
	snapshot: StatsSnapshot | null;
	/**
	 * When the poller last completed a tick (epoch ms). Bounds how long
	 * persisted state stays trustworthy across an unmounted gap - see
	 * STALE_TICKS.
	 */
	lastTickAt: number;
	/**
	 * True after a held tick (missing report or vanished entry): the
	 * counter baseline predates the gap, so the first recovered tick must
	 * not render gap-era drops as a "happening NOW" warning.
	 */
	baselineStale: boolean;
	/**
	 * Timestamp of the last processed inbound entry. Detects a CACHED
	 * report (same measurement window served twice): its counters equal
	 * the baseline the previous tick already advanced to, so the anomaly
	 * warning must be carried like the bitrate, not recomputed to false.
	 */
	lastReportTs: number | null;
}

/**
 * Invariant: at most ONE mounted consumer per track at a time (the call
 * grid renders one badge per track). Two simultaneous consumers would run
 * interleaved pollers mutating the same baselines - out-of-phase bitrate
 * windows, anomaly deltas split between them. If a second surface ever
 * needs the same track's stats (a PiP duplicate of a tile), lift the
 * polling so ticks are shared instead of mounting a second hook.
 */
const trackStates = new WeakMap<StatsTrack, TrackStatsState>();

function freshState(): TrackStatsState {
	return {
		sawFps: false,
		lastCounters: null,
		lastBytes: null,
		lastBitrate: null,
		lastEntryId: null,
		missingReports: 0,
		entryMissing: 0,
		slowPolling: false,
		snapshot: null,
		lastTickAt: 0,
		baselineStale: false,
		lastReportTs: null,
	};
}

/**
 * Polls a video track's WebRTC stats once per second and exposes the
 * render-ready {@link StatsSnapshot} (null = no badge). This is the whole
 * stats state machine; the consuming component only formats and positions
 * the readout. Reads inbound-rtp (receive side, #408); #409 extends this
 * for local tracks' outbound-rtp.
 *
 * Truthfulness invariants (each locked by a test):
 * - Only measured values render: bitrate comes from tick-to-tick byte
 *   deltas ("0 kbps" is always a measured zero; unmeasured is omitted),
 *   "0fps" only ever follows an earlier fps measurement on the same
 *   stream (a real stall), and nothing is inferred from capture settings.
 * - Per-stream baselines are keyed on the inbound entry's id and reset
 *   when it changes (SSRC restart) or goes away - stale state never
 *   misreads a successor stream.
 * - Transient misses hold the last-good readout (the anomaly warning's
 *   "now" claim decays immediately); only MAX_MISSING_REPORTS consecutive
 *   missing REPORTS clear it and drop to the recovery cadence, while a
 *   missing ENTRY on a live report settles on "no frames decoded" at
 *   full speed.
 * - State survives consumer remounts via a per-track WeakMap, so tile
 *   rebuilds (speaking flips, other shares starting) don't blank or
 *   re-baseline the readout.
 */
export function useTrackStats(
	track: Accessor<StatsTrack>,
): Accessor<StatsSnapshot | null> {
	const [snapshot, setSnapshot] = createSignal<StatsSnapshot | null>(null);

	createEffect(
		on(track, (t) => {
			const existing = trackStates.get(t);
			const state = existing ?? freshState();
			if (existing === undefined) {
				trackStates.set(t, state);
			} else {
				const staleAfterMs =
					STALE_TICKS *
					(state.slowPolling ? RECOVERY_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
				if (Date.now() - state.lastTickAt > staleAfterMs) {
					// The previous poller stopped a while ago: discard everything
					// and start over as if the track were new (see STALE_TICKS).
					// This also bounds a republished warning line's age - within
					// the fresh window the snapshot (anomaliesActive included) is
					// at most two ticks old and republishing it verbatim is honest.
					Object.assign(state, freshState());
				}
			}
			// Re-render the persisted readout immediately: a tile remount must
			// not blank the badge for a tick (a genuinely new track starts null).
			setSnapshot(state.snapshot);
			let disposed = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const publish = (s: StatsSnapshot | null): void => {
				state.snapshot = s;
				setSnapshot(s);
			};
			const cadence = (): number =>
				state.slowPolling ? RECOVERY_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
			// One-shot chain instead of setInterval: each tick schedules the
			// next at the CURRENT cadence, so fast<->recovery switches take
			// effect at the next step without rescheduling anywhere, and two
			// ticks can never overlap.
			const scheduleNext = (ms: number): void => {
				if (timer !== undefined) clearTimeout(timer);
				timer = setTimeout(() => {
					void tick().finally(() => {
						if (!disposed) scheduleNext(cadence());
					});
				}, ms);
			};
			const resetStreamState = (): void => {
				state.sawFps = false;
				state.lastCounters = null;
				state.lastBytes = null;
				state.lastBitrate = null;
			};
			const declareDead = (): void => {
				publish(null);
				resetStreamState();
				state.lastEntryId = null;
				state.entryMissing = 0;
				// The tick chain picks the recovery cadence up on its next step.
				state.slowPolling = true;
			};
			// Hold the last-good readout across what may be a transient miss
			// instead of flickering - but the warning line's "happening NOW"
			// claim decays immediately, since a held snapshot proves nothing
			// about the present. No-op once already decayed.
			const holdLastGood = (): void => {
				state.baselineStale = true;
				if (state.snapshot?.anomaliesActive) {
					publish({ ...state.snapshot, anomaliesActive: false });
				}
			};
			const registerMiss = (): void => {
				state.missingReports += 1;
				if (state.missingReports >= MAX_MISSING_REPORTS && !state.slowPolling) {
					declareDead();
					return;
				}
				holdLastGood();
			};
			const tick = async (): Promise<void> => {
				// Outer catch: the inner try guards getStats itself, but a throw
				// anywhere later (an exotic report entry, a downstream snapshot
				// subscriber) must degrade to "readout unchanged", not become an
				// unhandled rejection repeated every poll interval.
				try {
					// During teardown the receiver/peer connection may already be
					// gone, and stats must degrade to "no badge", never throw - the
					// try/catch covers synchronous throws from a disposed surface
					// as well as promise rejections.
					let report: RTCStatsReport | undefined;
					try {
						report = await t.getRTCStatsReport?.();
					} catch {
						report = undefined;
					}
					if (disposed) return;
					if (!report) {
						registerMiss();
						return;
					}
					state.missingReports = 0;
					// The tick chain resumes the fast cadence on its next step.
					state.slowPolling = false;
					const stats = readInboundVideoStats(report);
					if (stats.entryId === null && state.lastEntryId !== null) {
						// The inbound-rtp entry vanished from a LIVE report
						// (renegotiation, layer switch). Hold briefly like a missing
						// report, but never via declareDead - the surface is alive,
						// so after the hold window the badge settles on the honest
						// "no frames decoded" state at full cadence.
						state.entryMissing += 1;
						if (state.entryMissing < MAX_MISSING_REPORTS) {
							holdLastGood();
							return;
						}
						// Entry really gone: the old stream ended.
						resetStreamState();
						state.lastEntryId = null;
					}
					state.entryMissing = 0;
					if (stats.entryId !== null && stats.entryId !== state.lastEntryId) {
						// A different inbound-rtp entry (SSRC restart / replaced
						// publication, or the first one): fresh stream, fresh state.
						resetStreamState();
						state.lastEntryId = stats.entryId;
					}
					if (stats.framesPerSecond !== null) state.sawFps = true;
					// Bitrate from byte deltas (see StatsSnapshot.bitrate).
					let bitrate: number | null = null;
					if (stats.bytesReceived !== null && stats.timestamp !== null) {
						const last = state.lastBytes;
						if (last !== null && stats.timestamp === last.timestamp) {
							// Browser served a cached report (same measurement window):
							// carry the previous measurement instead of blinking the
							// number out for a tick. Baseline stays put.
							bitrate = state.lastBitrate;
						} else {
							if (
								last !== null &&
								stats.timestamp > last.timestamp &&
								stats.bytesReceived >= last.bytes
							) {
								bitrate =
									((stats.bytesReceived - last.bytes) * 8_000) /
									(stats.timestamp - last.timestamp);
							}
							// A byte counter that went BACKWARDS on the same entry
							// (receiver-internal reset) lands here with bitrate still
							// null: re-baseline and render unmeasured for one tick,
							// never a false "0 kbps".
							state.lastBytes = {
								bytes: stats.bytesReceived,
								timestamp: stats.timestamp,
							};
							state.lastBitrate = bitrate;
						}
					} else {
						// Counters absent: drop the baseline so a later reappearance
						// doesn't compute a delta across an unmeasured gap.
						state.lastBytes = null;
						state.lastBitrate = null;
					}
					// A cached report repeats the counters the baseline was already
					// advanced to - carry the warning like the bitrate instead of
					// blinking it off for a tick (see TrackStatsState.lastReportTs).
					// A baseline from before a held gap can't say what happened in
					// THIS interval - suppress the warning for the recovery tick
					// and re-baseline (see TrackStatsState.baselineStale).
					const cachedReport =
						stats.timestamp !== null && stats.timestamp === state.lastReportTs;
					state.lastReportTs = stats.timestamp;
					const anomaliesActive = cachedReport
						? (state.snapshot?.anomaliesActive ?? false)
						: !state.baselineStale &&
							state.lastCounters !== null &&
							(stats.framesDropped > state.lastCounters.dropped ||
								stats.freezeCount > state.lastCounters.freezes);
					if (!cachedReport) state.baselineStale = false;
					state.lastCounters = {
						dropped: stats.framesDropped,
						freezes: stats.freezeCount,
					};
					publish({
						frameWidth: stats.frameWidth,
						frameHeight: stats.frameHeight,
						// See formatFrameLine: null omits the fps segment (never
						// measured), 0 means a stall on a previously decoding stream.
						framesPerSecond: stats.framesPerSecond ?? (state.sawFps ? 0 : null),
						codec: stats.codec,
						decoder: stats.decoder,
						framesDropped: stats.framesDropped,
						freezeCount: stats.freezeCount,
						anomaliesActive,
						bitrate,
					});
				} catch {
					// See the outer-catch comment above: hold the readout.
				} finally {
					// Guarded on disposed: a getStats promise settling after
					// unmount published nothing, and stamping it would let a
					// remount trust state whose last real measurement is older
					// than the staleness bound claims.
					if (!disposed) state.lastTickAt = Date.now();
				}
			};
			// Preserve the poll PHASE across remounts: the call grid rebuilds
			// tiles constantly (speaking flips, share starts), and both an
			// immediate probe (sub-second delta windows -> false "0 kbps" /
			// keyframe-spiked rates) and a restarted full wait (starving the
			// recovery cadence until the staleness bound force-resets it)
			// would misbehave. The next tick lands exactly where the previous
			// mount's poller would have put it; a genuinely new track
			// (lastTickAt 0) probes immediately. Clamped to one cadence so a
			// backward wall-clock step (Date.now is not monotonic) can only
			// delay a poll by one interval, never freeze the badge for the
			// skew duration.
			const sinceLastTick = Date.now() - state.lastTickAt;
			scheduleNext(Math.min(cadence(), Math.max(0, cadence() - sinceLastTick)));
			onCleanup(() => {
				disposed = true;
				if (timer !== undefined) clearTimeout(timer);
			});
		}),
	);

	return snapshot;
}
