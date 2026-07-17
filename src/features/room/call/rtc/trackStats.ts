/**
 * Pure helpers for reading live video quality off a WebRTC stats report -
 * the receive side (inbound-rtp, #408) and the send side (outbound-rtp,
 * #409) share one shape and one reader. Kept free of runtime
 * `livekit-client` imports so the stats overlay doesn't pull the LiveKit
 * chunk into the bundle eagerly - the SDK is only fetched when a call is
 * joined (see `useLivekitRoom`).
 */

/** Which side of the pipe a readout describes. */
export type StatsDirection = "receive" | "send";

/** Snapshot of the video-quality fields the stats overlay renders. */
export interface VideoTrackStats {
	/**
	 * The report id of the selected RTP entry, or null when the report
	 * has none. Not rendered - the overlay's poll loop uses it to (a)
	 * hold the last-good readout when the entry VANISHES transiently
	 * from a live report instead of flickering, and (b) detect
	 * selected-entry changes; see useTrackStats for the direction-aware
	 * semantics (receive: any id change resets the stream baselines;
	 * send: fps history clears while the limitation spell carries by
	 * contract).
	 */
	entryId: string | null;
	/**
	 * Cumulative payload bytes (received, or sent SUMMED across simulcast
	 * layers - total upload) and the selected entry's timestamp (ms). Not
	 * rendered - the poll loop derives bitrate from tick-to-tick deltas
	 * of these, because livekit's `currentBitrate` monitor needs several
	 * seconds to warm up and would falsify the "0 kbps = nothing
	 * arriving/leaving" diagnosis on healthy new streams.
	 */
	bytes: number | null;
	timestamp: number | null;
	/**
	 * Sorted ids of every entry contributing to `bytes`, joined - the
	 * byte baseline's identity. Not rendered: the poll loop must drop its
	 * delta baseline whenever this changes (a NON-top simulcast layer
	 * churning moves the sum without the top entryId changing, which
	 * would otherwise spike then blank the derived bitrate).
	 */
	byteEntryIds: string | null;
	/**
	 * Decoded (receive) or encoded (send) frame width in px. Null until
	 * the first frame - including when the RTP entry is missing entirely
	 * - so a null here means "no frames", which the overlay surfaces
	 * explicitly rather than papering over.
	 */
	frameWidth: number | null;
	/** Frame height in px, or null when not yet reported. */
	frameHeight: number | null;
	/** Decoded/encoded frames per second, or null when not yet reported. */
	framesPerSecond: number | null;
	/** Codec short name from the codec entry's mimeType, e.g. "VP9". */
	codec: string | null;
	/**
	 * Whether decode (receive) / encode (send) is hardware-accelerated,
	 * from Chrome's `powerEfficientDecoder`/`powerEfficientEncoder`
	 * stats extensions. Null on browsers that don't expose them.
	 */
	accel: "hw" | "sw" | null;
	/** Cumulative receiver-side dropped frames (always 0 on send). */
	framesDropped: number;
	/** Cumulative playback freezes (Chrome extension; always 0 on send). */
	freezeCount: number;
	/**
	 * The encoder's current quality limitation ("none" | "cpu" |
	 * "bandwidth" | "other"), send side only (null on receive). Unlike
	 * the cumulative counters this is a LIVE value - render it directly.
	 */
	qualityLimitationReason: string | null;
	/**
	 * Cumulative seconds spent under the CURRENT limitation reason, from
	 * `qualityLimitationDurations`. Null when unlimited or not exposed.
	 */
	qualityLimitationSeconds: number | null;
}

function emptyVideoTrackStats(): VideoTrackStats {
	return {
		entryId: null,
		bytes: null,
		timestamp: null,
		byteEntryIds: null,
		frameWidth: null,
		frameHeight: null,
		framesPerSecond: null,
		codec: null,
		accel: null,
		framesDropped: 0,
		freezeCount: 0,
		qualityLimitationReason: null,
		qualityLimitationSeconds: null,
	};
}

// Stats entries are read via index access because the interesting fields
// (framesPerSecond, freezeCount, powerEfficientDecoder, ...) are spec
// extensions missing from lib.dom's RTCStats types; every read is
// type-checked at runtime instead.
function numField(entry: Record<string, unknown>, key: string): number | null {
	const v = entry[key];
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Whether a send-side simulcast layer is currently encoding. The spec's
// `active` boolean on outbound-rtp is the direct discriminator; where a
// browser omits it, fall back to a nonzero framesPerSecond (a deactivated
// layer can report a PRESENT fps of 0, which must not count as active).
function sendLayerActive(entry: Record<string, unknown>): boolean {
	if (typeof entry.active === "boolean") return entry.active;
	return (numField(entry, "framesPerSecond") ?? 0) > 0;
}

// Pick the entry the readout describes when a report carries several.
// Entries in one report usually share a single collection timestamp, so
// content signals decide first and timestamp only breaks remaining ties
// (it discriminates cross-staleness on report shapes with per-entry
// stamps without letting stamp jitter flip-flop the choice). Send side:
// the ACTIVE layer beats size (a bandwidth-deactivated top layer keeps
// its last-encoded frameWidth and must not render as a false stall over
// a streaming lower layer), then an actually-flowing one (both entries
// can claim active:true while only one reports framesPerSecond), then
// the largest frame (the top layer of a simulcast set). Receive side:
// an actively-decoding entry wins. On a full tie prefer the
// later-iterated candidate: stats maplikes commonly iterate in insertion
// order (not spec-guaranteed), putting a replacement entry after the
// dying one; there is no reliable discriminator at a full tie, and a
// mis-pick self-heals within a tick or two once the dead entry is
// pruned.
function preferEntry(
	candidate: Record<string, unknown>,
	current: Record<string, unknown>,
	direction: StatsDirection,
): boolean {
	const candidateFps = numField(candidate, "framesPerSecond") !== null;
	const currentFps = numField(current, "framesPerSecond") !== null;
	if (direction === "send") {
		const candidateActive = sendLayerActive(candidate);
		const currentActive = sendLayerActive(current);
		if (candidateActive !== currentActive) return candidateActive;
		if (candidateFps !== currentFps) return candidateFps;
		const candidateW = numField(candidate, "frameWidth") ?? -1;
		const currentW = numField(current, "frameWidth") ?? -1;
		if (candidateW !== currentW) return candidateW > currentW;
	} else if (candidateFps !== currentFps) {
		return candidateFps;
	}
	const candidateTs = numField(candidate, "timestamp") ?? -1;
	const currentTs = numField(current, "timestamp") ?? -1;
	if (candidateTs !== currentTs) return candidateTs > currentTs;
	return true;
}

/**
 * Extract the video-quality snapshot for one direction from a track's
 * `getRTCStatsReport()` result: the selected RTP entry plus the codec
 * entry it references. Absent entries/fields degrade to nulls (and zero
 * counters) rather than throwing, since browsers differ in which stats
 * extensions they expose.
 */
export function readVideoTrackStats(
	report: RTCStatsReport,
	direction: StatsDirection,
): VideoTrackStats {
	const entryType = direction === "receive" ? "inbound-rtp" : "outbound-rtp";
	const bytesField = direction === "receive" ? "bytesReceived" : "bytesSent";
	const accelField =
		direction === "receive" ? "powerEfficientDecoder" : "powerEfficientEncoder";

	const entries: Record<string, unknown>[] = [];
	report.forEach((entry) => {
		const e = entry as Record<string, unknown>;
		if (e.type !== entryType || e.kind !== "video") return;
		// Spec guarantees every stats entry a string id, and the poll loop
		// keys per-stream state on it - an id-less object is not usable.
		if (typeof e.id !== "string") return;
		entries.push(e);
	});
	if (entries.length === 0) return emptyVideoTrackStats();

	let top = entries[0];
	for (const e of entries) {
		if (e !== top && preferEntry(e, top, direction)) top = e;
	}

	// Send bitrate is the TOTAL upload: sum bytesSent across simulcast
	// layers. Receive has a single selected entry.
	let bytes: number | null = null;
	let byteEntryIds: string | null = null;
	if (direction === "send") {
		const contributing: string[] = [];
		for (const e of entries) {
			const b = numField(e, bytesField);
			if (b !== null) {
				bytes = (bytes ?? 0) + b;
				contributing.push(e.id as string);
			}
		}
		if (contributing.length > 0) byteEntryIds = contributing.sort().join(",");
	} else {
		bytes = numField(top, bytesField);
		if (bytes !== null) byteEntryIds = top.id as string;
	}

	let codec: string | null = null;
	if (typeof top.codecId === "string") {
		const codecEntry = report.get(top.codecId) as
			| Record<string, unknown>
			| undefined;
		if (typeof codecEntry?.mimeType === "string") {
			// "video/VP9" -> "VP9"; tolerate a bare codec name too.
			codec =
				(codecEntry.mimeType.split("/").pop() ?? "").toUpperCase() || null;
		}
	}

	let qualityLimitationReason: string | null = null;
	let qualityLimitationSeconds: number | null = null;
	if (direction === "send") {
		const reason = top.qualityLimitationReason;
		qualityLimitationReason = typeof reason === "string" ? reason : null;
		const durations = top.qualityLimitationDurations;
		if (
			qualityLimitationReason !== null &&
			qualityLimitationReason !== "none" &&
			typeof durations === "object" &&
			durations !== null
		) {
			qualityLimitationSeconds = numField(
				durations as Record<string, unknown>,
				qualityLimitationReason,
			);
		}
	}

	const powerEfficient = top[accelField];
	return {
		entryId: top.id as string,
		bytes,
		timestamp: numField(top, "timestamp"),
		byteEntryIds,
		frameWidth: numField(top, "frameWidth"),
		frameHeight: numField(top, "frameHeight"),
		framesPerSecond: numField(top, "framesPerSecond"),
		codec,
		accel:
			typeof powerEfficient === "boolean"
				? powerEfficient
					? "hw"
					: "sw"
				: null,
		framesDropped: numField(top, "framesDropped") ?? 0,
		freezeCount: numField(top, "freezeCount") ?? 0,
		qualityLimitationReason,
		qualityLimitationSeconds,
	};
}

/**
 * Human-readable bitrate: whole kbps below 1 Mbps, one-decimal Mbps above.
 * The non-finite/negative clamp to "0 kbps" is pure input hardening - the
 * product caller passes either a measured non-negative delta rate or null
 * (an UNMEASURED rate, which formatRateLine renders as an omitted segment,
 * never as a fake zero).
 */
export function formatBitrate(bitsPerSecond: number): string {
	const bps =
		Number.isFinite(bitsPerSecond) && bitsPerSecond > 0 ? bitsPerSecond : 0;
	const kbps = Math.round(bps / 1_000);
	if (kbps < 1_000) return `${kbps} kbps`;
	return `${(bps / 1_000_000).toFixed(1)} Mbps`;
}

/**
 * "2560x1440 · 60fps". No frame size means no frames have flowed; say so
 * explicitly per direction ("no frames decoded" / "no frames sent" - the
 * rate line then distinguishes "nothing arriving" from "arriving but not
 * decoding"). A null framesPerSecond omits the fps segment - the caller
 * passes null while the rate is genuinely unmeasured (a stream's first
 * second) and 0 for a stall, so "0fps" always means a stream that flowed
 * before and stopped.
 */
export function formatFrameLine(
	frameWidth: number | null,
	frameHeight: number | null,
	framesPerSecond: number | null,
	direction: StatsDirection,
): string {
	if (frameWidth === null || frameHeight === null) {
		return direction === "send" ? "no frames sent" : "no frames decoded";
	}
	// A trickling sub-1fps stream renders "<1fps", never a rounded "0fps"
	// that would falsely claim a stall while frames still arrive.
	let fps = "";
	if (framesPerSecond !== null) {
		const rendered =
			framesPerSecond > 0 && framesPerSecond < 1
				? "<1"
				: `${Math.round(framesPerSecond)}`;
		fps = ` · ${rendered}fps`;
	}
	return `${frameWidth}x${frameHeight}${fps}`;
}

/**
 * "7.9 Mbps · VP9 hw" - every segment drops out when unknown, so an
 * unmeasured bitrate (a stream's first tick has no delta baseline yet)
 * renders no number at all rather than a false "0 kbps", and the line can
 * be empty (caller hides it). A MEASURED zero still renders "0 kbps" -
 * that's the honest "nothing arriving/leaving" diagnosis.
 */
export function formatRateLine(
	bitrate: number | null,
	codec: string | null,
	accel: "hw" | "sw" | null,
): string {
	const parts: string[] = [];
	if (bitrate !== null) parts.push(formatBitrate(bitrate));
	if (codec) parts.push(accel ? `${codec} ${accel}` : codec);
	return parts.join(" · ");
}

/**
 * "12 dropped · 3 freezes", or null when both counters are zero. The
 * counters are cumulative since subscription; the caller decides when the
 * line is a CURRENT warning (only while the counters are actively
 * increasing), this just formats it.
 */
export function formatAnomalyLine(
	framesDropped: number,
	freezeCount: number,
): string | null {
	const parts: string[] = [];
	if (framesDropped > 0) parts.push(`${framesDropped} dropped`);
	if (freezeCount > 0) {
		parts.push(`${freezeCount} ${freezeCount === 1 ? "freeze" : "freezes"}`);
	}
	return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * "cpu limited · 34s", or null when unlimited/unknown. The reason is the
 * encoder's LIVE self-report (send side); the seconds are the CURRENT
 * spell's duration (the poll loop derives it from the cumulative stats)
 * and the segment is omitted while under a second - a spell that just
 * started reads as "cpu limited", not "cpu limited · 0s".
 */
export function formatLimitationLine(
	reason: string | null,
	seconds: number | null,
): string | null {
	if (reason === null || reason === "none") return null;
	const duration =
		seconds !== null && seconds >= 1 ? ` · ${Math.round(seconds)}s` : "";
	return `${reason} limited${duration}`;
}
