import type { LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import {
	type Accessor,
	createEffect,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import {
	readVideoTrackStats,
	type StatsDirection,
	type VideoTrackStats,
} from "./trackStats";

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
 * A tick gap beyond this many ticks of the state's OWN cadence (fast or
 * recovery) marks measurement baselines stale: deltas spanning the gap
 * would render gap-era drops and gap-averaged bitrates as current, so
 * they re-baseline (one unmeasured tick) and the warning claims decay -
 * but the readout itself holds, because ~1-2s of main-thread jank (a
 * share starting, a heavy render) is routine mid-call and must not wipe
 * history.
 */
const STALE_TICKS = 2;

/**
 * A gap beyond this discards the persisted state WHOLESALE: the badge
 * was unmounted (setting off, tile gone) or the tab throttled long
 * enough that even the snapshot is stale news. Chosen below hidden-tab
 * intensive-throttling clamps (>=60s) and far above any jank.
 */
const WHOLESALE_STALE_MS = 30_000;

/**
 * The fields the stats badge renders - the parsed stats minus the
 * poll-loop-only fields (the entry ids and raw byte/timestamp counters
 * must not leak into render state), plus the two values the loop derives.
 * One shape for both directions; direction-specific fields are null/zero
 * on the other side.
 */
export interface StatsSnapshot
	extends Omit<
		VideoTrackStats,
		"entryId" | "bytes" | "timestamp" | "byteEntryIds"
	> {
	/**
	 * Bitrate in bits/sec, derived from tick-to-tick byte deltas
	 * (received, or sent summed across simulcast layers). Null until a
	 * delta baseline exists (a stream's first tick), which renders as no
	 * number rather than a false "0 kbps".
	 */
	bitrate: number | null;
	/**
	 * True when the drop/freeze counters increased during the last poll
	 * interval. The counters themselves are cumulative since subscription,
	 * so this is what makes the warning line mean "happening NOW" rather
	 * than "happened at some point in this call". Always false on send -
	 * the send-side warning is the live qualityLimitationReason.
	 */
	anomaliesActive: boolean;
}

type StatsTrack = LocalVideoTrack | RemoteVideoTrack;

/**
 * Measurement baselines scoped to ONE stream (RTP publication). Nested
 * in a single sub-object so the stream reset is structurally complete:
 * `state.stream = freshStreamState()` cannot forget a field the way a
 * hand-maintained reset function can, and a leaked baseline is exactly
 * the stale-state-misreads-a-fresh-stream bug class this module's
 * invariants exist to prevent.
 */
interface StreamMeasureState {
	/**
	 * Whether framesPerSecond has ever been reported for this stream.
	 * Distinguishes "not measured yet" (first second - omit the fps
	 * segment) from "measured before, absent now" (a stall - 0fps).
	 */
	sawFps: boolean;
	/**
	 * Previous tick's cumulative counters, so the warning line only shows
	 * while they're actively increasing.
	 */
	lastCounters: { dropped: number; freezes: number } | null;
	/** Previous tick's byte counter + timestamp: the bitrate delta baseline. */
	lastBytes: { bytes: number; timestamp: number } | null;
	/**
	 * Which entries the byte baseline was summed over (see
	 * VideoTrackStats.byteEntryIds): the baseline is only comparable to a
	 * sum over the SAME population.
	 */
	lastByteIds: string | null;
	/** Last measured bitrate, carried across cached (same-timestamp) reports. */
	lastBitrate: number | null;
	/**
	 * Limitation-spell tracking: the parser reports CONNECTION-CUMULATIVE
	 * seconds, the badge shows the CURRENT spell. `limitSpellBase` anchors
	 * the selected entry's cumulative clock, `limitSpellCarry` preserves
	 * elapsed time across simulcast layer flips (each entry has its own
	 * clock), and `limitSpellElapsed` is the last computed spell length -
	 * kept HERE (not read back from the published snapshot, whose warning
	 * fields decay on held ticks).
	 */
	lastLimitReason: string | null;
	limitSpellBase: number | null;
	limitSpellCarry: number;
	limitSpellElapsed: number;
}

function freshStreamState(): StreamMeasureState {
	return {
		sawFps: false,
		lastCounters: null,
		lastBytes: null,
		lastByteIds: null,
		lastBitrate: null,
		lastLimitReason: null,
		limitSpellBase: null,
		limitSpellCarry: 0,
		limitSpellElapsed: 0,
	};
}

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
	 * Which direction this state was measured for. A track is normally
	 * polled in one direction forever, but if a consumer ever remounts
	 * with the other direction (isLocal correcting itself), the persisted
	 * receive-state must not seed the send badge or vice versa.
	 */
	direction: StatsDirection;
	/** Per-stream measurement baselines (see StreamMeasureState). */
	stream: StreamMeasureState;
	/** Which RTP entry the stream state belongs to. */
	lastEntryId: string | null;
	/** Consecutive ticks whose report was missing entirely. */
	missingReports: number;
	/**
	 * Consecutive live reports whose RTP entry was missing after
	 * previously being present. Tracked separately from missingReports: a
	 * vanished ENTRY on a live surface must never slow polling down - it
	 * settles on the honest "no frames" state at full cadence.
	 */
	entryMissing: number;
	/** Whether polling is currently on the recovery cadence. */
	slowPolling: boolean;
	/** The last published readout, re-rendered instantly on remount. */
	snapshot: StatsSnapshot | null;
	/**
	 * When the poller last completed a tick (epoch ms). Bounds how long
	 * persisted state stays trustworthy across a gap - see STALE_TICKS.
	 */
	lastTickAt: number;
	/**
	 * True after a held tick (missing report or vanished entry): the
	 * counter baseline predates the gap, so the first recovered tick must
	 * not render gap-era drops as a "happening NOW" warning.
	 */
	baselineStale: boolean;
	/**
	 * Timestamp of the last processed RTP entry. Detects a CACHED
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

function freshState(direction: StatsDirection): TrackStatsState {
	return {
		direction,
		stream: freshStreamState(),
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
 * the readout. Reads inbound-rtp for remote tracks (receive side, #408)
 * or outbound-rtp for local ones (send side, #409) - the direction only
 * changes which entries are parsed, never the lifecycle logic.
 *
 * Truthfulness invariants (each locked by a test):
 * - Only measured values render: bitrate comes from tick-to-tick byte
 *   deltas ("0 kbps" is always a measured zero; unmeasured is omitted),
 *   "0fps" only ever follows an earlier fps measurement on the SAME
 *   selected entry (a real stall - fps history clears on any
 *   selected-entry change), and nothing is inferred from capture
 *   settings.
 * - Receive-side baselines reset whenever the selected inbound entry id
 *   changes (a restart/replaced publication). Send side deliberately
 *   does NOT discriminate layer flips from republications (no reliable
 *   intra-report signal exists): the limitation spell describes how
 *   long this track's outgoing quality has been limited for a reason -
 *   a condition an internal republication does not lift - so it
 *   carries across any selected-entry change, rebasing onto the new
 *   entry's cumulative clock. Byte baselines are keyed on the entry
 *   population.
 * - Transient misses hold the last-good readout while BOTH directions'
 *   "now" claims (anomaly flag, encoder limitation) decay immediately;
 *   only MAX_MISSING_REPORTS consecutive missing REPORTS clear it and
 *   drop to the recovery cadence, while a missing ENTRY on a live report
 *   settles on "no frames" at full speed.
 * - State survives consumer remounts via a per-track WeakMap (stamped
 *   with its direction). A gap beyond the soft bound re-baselines the
 *   measurements and decays the warning claims but holds the readout
 *   (jank tolerance); a gap beyond WHOLESALE_STALE_MS discards
 *   everything.
 */
export function useTrackStats(
	track: Accessor<StatsTrack>,
	direction: StatsDirection,
): Accessor<StatsSnapshot | null> {
	const [snapshot, setSnapshot] = createSignal<StatsSnapshot | null>(null);

	createEffect(
		on(track, (t) => {
			const existing = trackStates.get(t);
			const state = existing ?? freshState(direction);
			if (existing === undefined) {
				trackStates.set(t, state);
			} else if (existing.direction !== direction) {
				// The other direction's measurements must not seed this badge.
				Object.assign(state, freshState(direction));
			}
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
			// THE staleness policy (single definition), applied both at mount
			// and per-tick, covering unmounted gaps and throttled/janked timer
			// chains alike. A soft-stale gap re-baselines the measurements and
			// decays the warning claims but HOLDS the readout (routine jank must
			// not wipe mid-call history - the limitation spell's cumulative math
			// is gap-immune); a wholesale-stale gap discards everything.
			const handleTickGap = (): void => {
				if (state.lastTickAt === 0) return;
				const gap = Date.now() - state.lastTickAt;
				if (gap > WHOLESALE_STALE_MS) {
					// Brand-new-track semantics: everything resets (lastTickAt 0
					// schedules an immediate probe, which is correct - every baseline
					// is fresh, so no delta can span the gap).
					Object.assign(state, freshState(direction));
					setSnapshot(null);
					return;
				}
				if (gap > STALE_TICKS * cadence()) {
					state.stream.lastBytes = null;
					state.stream.lastBitrate = null;
					state.baselineStale = true;
					const held = state.snapshot;
					if (
						held &&
						(held.anomaliesActive || held.qualityLimitationReason !== null)
					) {
						// Publish the decay, not just record it: the renderer must drop
						// the stale "now" claims immediately, and holdLastGood no-ops on
						// an already-decayed snapshot.
						const decayed = {
							...held,
							anomaliesActive: false,
							qualityLimitationReason: null,
							qualityLimitationSeconds: null,
						};
						state.snapshot = decayed;
						setSnapshot(decayed);
					}
				}
			};
			handleTickGap();
			// Re-render the persisted readout immediately: a tile remount must
			// not blank the badge for a tick (a genuinely new track starts null).
			setSnapshot(state.snapshot);
			const declareDead = (): void => {
				// Structural reset with two carve-outs: lastTickAt preserves the
				// poll phase (a remount must not immediately re-probe the dead
				// surface), slowPolling puts the tick chain on the recovery
				// cadence at its next step.
				const keptTickAt = state.lastTickAt;
				Object.assign(state, freshState(direction));
				state.lastTickAt = keptTickAt;
				state.slowPolling = true;
				publish(null);
			};
			// Hold the last-good readout across what may be a transient miss
			// instead of flickering - but BOTH directions' "happening NOW"
			// claims decay immediately (the receive-side anomaly flag and the
			// send-side encoder limitation), since a held snapshot proves
			// nothing about the present. No-op once already decayed.
			const holdLastGood = (): void => {
				state.baselineStale = true;
				const held = state.snapshot;
				if (
					held &&
					(held.anomaliesActive || held.qualityLimitationReason !== null)
				) {
					publish({
						...held,
						anomaliesActive: false,
						qualityLimitationReason: null,
						qualityLimitationSeconds: null,
					});
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
				handleTickGap();
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
					const stats = readVideoTrackStats(report, direction);
					if (stats.entryId === null && state.lastEntryId !== null) {
						// The RTP entry vanished from a LIVE report
						// (renegotiation, layer switch). Hold briefly like a missing
						// report, but never via declareDead - the surface is alive,
						// so after the hold window the badge settles on the honest
						// "no frames" state at full cadence.
						state.entryMissing += 1;
						if (state.entryMissing < MAX_MISSING_REPORTS) {
							holdLastGood();
							return;
						}
						// Entry really gone: the old stream ended.
						state.stream = freshStreamState();
						state.lastEntryId = null;
					}
					state.entryMissing = 0;
					if (stats.entryId !== null && stats.entryId !== state.lastEntryId) {
						if (direction === "receive") {
							// A different inbound entry is a restart/replaced publication:
							// fresh stream, fresh state.
							state.stream = freshStreamState();
						} else {
							// Send side: a selected-entry change is a simulcast layer flip
							// or an internal republication - EITHER WAY the encoder's
							// limitation describes the same real-world condition on this
							// track, so the spell carries by contract, rebasing onto the
							// new entry's cumulative clock. (No flip-vs-restart
							// discrimination: within a single report there is no reliable
							// signal, and continuity is the more truthful reading of a
							// limitation the restart did not lift.) fps history is
							// per-entry: the new entry's first fps-less tick is "not
							// measured yet", never an inherited 0fps stall. Byte baselines
							// are keyed on the entry population separately.
							state.stream.limitSpellCarry = state.stream.limitSpellElapsed;
							state.stream.limitSpellBase = null;
							state.stream.sawFps = false;
						}
						state.lastEntryId = stats.entryId;
					}
					const stream = state.stream;
					if (stats.framesPerSecond !== null) stream.sawFps = true;
					// ONE cached-report check feeds every carry: a report with the
					// same collection timestamp as the previous tick repeats the
					// measurements the baselines were already advanced to, so the
					// bitrate AND the anomaly warning both carry instead of blinking
					// for a tick (see TrackStatsState.lastReportTs).
					const cachedReport =
						stats.timestamp !== null && stats.timestamp === state.lastReportTs;
					state.lastReportTs = stats.timestamp;
					// Bitrate from byte deltas (see StatsSnapshot.bitrate).
					let bitrate: number | null = null;
					if (stats.bytes !== null && stats.timestamp !== null) {
						if (stats.byteEntryIds !== stream.lastByteIds) {
							// The entry population behind the byte sum changed (e.g. a
							// lower simulcast layer churned without the top entry
							// changing): the old baseline measures a different sum -
							// re-baseline (one unmeasured tick) rather than letting the
							// delta spike and then blank.
							stream.lastBytes = null;
							stream.lastBitrate = null;
							stream.lastByteIds = stats.byteEntryIds;
						}
						const last = stream.lastBytes;
						if (cachedReport) {
							bitrate = stream.lastBitrate;
						} else {
							if (
								last !== null &&
								stats.timestamp > last.timestamp &&
								stats.bytes >= last.bytes
							) {
								bitrate =
									((stats.bytes - last.bytes) * 8_000) /
									(stats.timestamp - last.timestamp);
							}
							// A byte counter that went BACKWARDS on the same entry
							// (receiver-internal reset) lands here with bitrate still
							// null: re-baseline and render unmeasured for one tick,
							// never a false "0 kbps".
							stream.lastBytes = {
								bytes: stats.bytes,
								timestamp: stats.timestamp,
							};
							stream.lastBitrate = bitrate;
						}
					} else {
						// Counters absent: drop the baseline so a later reappearance
						// doesn't compute a delta across an unmeasured gap.
						stream.lastBytes = null;
						stream.lastBitrate = null;
						stream.lastByteIds = null;
					}
					const anomaliesActive = cachedReport
						? (state.snapshot?.anomaliesActive ?? false)
						: !state.baselineStale &&
							stream.lastCounters !== null &&
							(stats.framesDropped > stream.lastCounters.dropped ||
								stats.freezeCount > stream.lastCounters.freezes);
					if (!cachedReport) state.baselineStale = false;
					stream.lastCounters = {
						dropped: stats.framesDropped,
						freezes: stats.freezeCount,
					};
					// The parser reports CONNECTION-CUMULATIVE limitation seconds;
					// render the CURRENT spell by baselining when the reason
					// (re)starts, so a limitation from earlier in the call never
					// inflates a just-started one. If the overlay mounts mid-spell
					// the baseline starts at "now" - an understated "at least Ns",
					// never an overstated one.
					const reason = stats.qualityLimitationReason;
					let limitSeconds: number | null = null;
					if (
						reason !== null &&
						reason !== "none" &&
						stats.qualityLimitationSeconds !== null
					) {
						if (stream.lastLimitReason !== reason) {
							// A new spell starts its clock at zero.
							stream.limitSpellCarry = 0;
							stream.limitSpellBase = stats.qualityLimitationSeconds;
						} else if (stream.limitSpellBase === null) {
							// Same spell on a new cumulative clock (layer flip): rebase,
							// keeping the elapsed time carried over.
							stream.limitSpellBase = stats.qualityLimitationSeconds;
						}
						limitSeconds =
							stream.limitSpellCarry +
							(stats.qualityLimitationSeconds - stream.limitSpellBase);
						stream.limitSpellElapsed = limitSeconds;
					} else {
						stream.limitSpellBase = null;
						stream.limitSpellCarry = 0;
						stream.limitSpellElapsed = 0;
					}
					stream.lastLimitReason = reason;
					publish({
						frameWidth: stats.frameWidth,
						frameHeight: stats.frameHeight,
						// See formatFrameLine: null omits the fps segment (never
						// measured), 0 means a stall on a previously flowing stream.
						framesPerSecond:
							stats.framesPerSecond ?? (stream.sawFps ? 0 : null),
						codec: stats.codec,
						accel: stats.accel,
						framesDropped: stats.framesDropped,
						freezeCount: stats.freezeCount,
						qualityLimitationReason: stats.qualityLimitationReason,
						qualityLimitationSeconds: limitSeconds,
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
