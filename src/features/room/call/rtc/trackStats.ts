/**
 * Pure helpers for reading live received-video quality off a WebRTC stats
 * report (#408). Kept free of runtime `livekit-client` imports so the stats
 * overlay doesn't pull the LiveKit chunk into the bundle eagerly - the SDK
 * is only fetched when a call is joined (see `useLivekitRoom`).
 */

/** Snapshot of the received-video quality fields the stats overlay renders. */
export interface InboundVideoStats {
	/**
	 * The report id of the video inbound-rtp entry, or null when the
	 * report has none. Not rendered - the overlay's poll loop uses it to
	 * (a) hold the last-good readout when the entry VANISHES transiently
	 * from a live report (renegotiation, layer switch) instead of
	 * flickering, and (b) reset per-stream state when the id CHANGES
	 * (SSRC restart / replaced publication), so a stale fps flag or
	 * counter baseline never misreads a fresh stream.
	 */
	entryId: string | null;
	/**
	 * Cumulative received payload bytes and the entry's timestamp (ms).
	 * Not rendered - the poll loop derives bitrate from tick-to-tick
	 * deltas of these, because livekit's `currentBitrate` monitor needs
	 * several seconds to warm up and would falsify the "0 kbps = nothing
	 * arriving" diagnosis on healthy new streams.
	 */
	bytesReceived: number | null;
	timestamp: number | null;
	/**
	 * Decoded frame width in px. Null until the first frame decodes -
	 * including when the inbound-rtp entry is missing entirely - so a
	 * null here means "nothing decoded", which the overlay surfaces
	 * explicitly rather than papering over.
	 */
	frameWidth: number | null;
	/** Decoded frame height in px, or null when not yet reported. */
	frameHeight: number | null;
	/** Decoded frames per second, or null when not yet reported. */
	framesPerSecond: number | null;
	/** Codec short name from the codec entry's mimeType, e.g. "VP9". */
	codec: string | null;
	/**
	 * Whether decode is hardware-accelerated, derived from Chrome's
	 * `powerEfficientDecoder` stats extension. Null on browsers that
	 * don't expose it.
	 */
	decoder: "hw" | "sw" | null;
	/** Cumulative receiver-side dropped frames. */
	framesDropped: number;
	/** Cumulative playback freezes (Chrome-only stats extension). */
	freezeCount: number;
}

function emptyInboundVideoStats(): InboundVideoStats {
	return {
		entryId: null,
		bytesReceived: null,
		timestamp: null,
		frameWidth: null,
		frameHeight: null,
		framesPerSecond: null,
		codec: null,
		decoder: null,
		framesDropped: 0,
		freezeCount: 0,
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

// Around an SSRC restart a report can transiently carry BOTH the ended and
// the new inbound-rtp entry; pick deterministically so the choice can't
// latch onto the dead one or flip-flop between ticks: freshest timestamp
// wins, then an actively-decoding entry (framesPerSecond present). On a
// full tie (restart overlap before the new stream decodes its first
// frame) prefer the later-iterated candidate: stats maplikes commonly
// iterate in insertion order (not spec-guaranteed), putting the
// replacement entry after the dying one. There is no reliable
// discriminator at a full tie, and a mis-pick self-heals within a tick
// or two - the dead entry disappears and the id-change reset kicks in.
function preferInbound(
	candidate: Record<string, unknown>,
	current: Record<string, unknown>,
): boolean {
	const candidateTs = numField(candidate, "timestamp") ?? -1;
	const currentTs = numField(current, "timestamp") ?? -1;
	if (candidateTs !== currentTs) return candidateTs > currentTs;
	const candidateFps = numField(candidate, "framesPerSecond") !== null;
	const currentFps = numField(current, "framesPerSecond") !== null;
	if (candidateFps !== currentFps) return candidateFps;
	return true;
}

/**
 * Extract the received-video quality snapshot from a track's
 * `getRTCStatsReport()` result: the video `inbound-rtp` entry plus the
 * codec entry it references. Absent entries/fields degrade to nulls (and
 * zero counters) rather than throwing, since browsers differ in which
 * stats extensions they expose.
 */
export function readInboundVideoStats(
	report: RTCStatsReport,
): InboundVideoStats {
	let inbound: Record<string, unknown> | undefined;
	report.forEach((entry) => {
		const e = entry as Record<string, unknown>;
		if (e.type !== "inbound-rtp" || e.kind !== "video") return;
		// Spec guarantees every stats entry a string id, and the poll loop
		// keys per-stream state on it - an id-less object is not usable.
		if (typeof e.id !== "string") return;
		if (inbound === undefined || preferInbound(e, inbound)) inbound = e;
	});
	if (!inbound) return emptyInboundVideoStats();

	let codec: string | null = null;
	if (typeof inbound.codecId === "string") {
		const codecEntry = report.get(inbound.codecId) as
			| Record<string, unknown>
			| undefined;
		if (typeof codecEntry?.mimeType === "string") {
			// "video/VP9" -> "VP9"; tolerate a bare codec name too.
			codec =
				(codecEntry.mimeType.split("/").pop() ?? "").toUpperCase() || null;
		}
	}

	const powerEfficient = inbound.powerEfficientDecoder;
	return {
		entryId: inbound.id as string,
		bytesReceived: numField(inbound, "bytesReceived"),
		timestamp: numField(inbound, "timestamp"),
		frameWidth: numField(inbound, "frameWidth"),
		frameHeight: numField(inbound, "frameHeight"),
		framesPerSecond: numField(inbound, "framesPerSecond"),
		codec,
		decoder:
			typeof powerEfficient === "boolean"
				? powerEfficient
					? "hw"
					: "sw"
				: null,
		framesDropped: numField(inbound, "framesDropped") ?? 0,
		freezeCount: numField(inbound, "freezeCount") ?? 0,
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
 * "2560x1440 · 60fps". No frame size means nothing has ever decoded; say
 * so explicitly (the rate line then distinguishes "nothing arriving" from
 * "arriving but not decoding"). A null framesPerSecond omits the fps
 * segment - the caller passes null while the rate is genuinely unmeasured
 * (a stream's first second) and 0 for a stall, so "0fps" always means a
 * stream that decoded before and stopped.
 */
export function formatFrameLine(
	frameWidth: number | null,
	frameHeight: number | null,
	framesPerSecond: number | null,
): string {
	if (frameWidth === null || frameHeight === null) return "no frames decoded";
	const fps =
		framesPerSecond !== null ? ` · ${Math.round(framesPerSecond)}fps` : "";
	return `${frameWidth}x${frameHeight}${fps}`;
}

/**
 * "7.9 Mbps · VP9 hw" - every segment drops out when unknown, so an
 * unmeasured bitrate (a stream's first tick has no delta baseline yet)
 * renders no number at all rather than a false "0 kbps", and the line can
 * be empty (caller hides it). A MEASURED zero still renders "0 kbps" -
 * that's the honest "nothing arriving" diagnosis.
 */
export function formatRateLine(
	bitrate: number | null,
	codec: string | null,
	decoder: "hw" | "sw" | null,
): string {
	const parts: string[] = [];
	if (bitrate !== null) parts.push(formatBitrate(bitrate));
	if (codec) parts.push(decoder ? `${codec} ${decoder}` : codec);
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
