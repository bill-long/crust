import type { MatrixEvent } from "matrix-js-sdk";

/**
 * Tracks the offset between the client's local clock and the homeserver's
 * clock. Used by call-active expiry logic so that a client with a skewed
 * clock (NTP misconfigured, VM clock drift, manually set wall time, etc.)
 * still computes "is this call membership expired?" against server time —
 * the same clock the homeserver used to populate `created_ts` and `expires`.
 *
 * The offset is sampled from server-delivered events. matrix-js-sdk sets
 * `MatrixEvent.localTimestamp = Date.now() - unsigned.age` at construction.
 * Therefore `origin_server_ts - localTimestamp ≈ serverNow - clientNow` at
 * the moment of receipt, which is exactly the offset we want.
 *
 * Sampling rules:
 *  - Only events whose `unsigned.age` is a finite number are sampled. This
 *    excludes local echoes (where `age` is absent and `localTimestamp`
 *    falls back to `Date.now()`, which would falsely zero the offset) as
 *    well as synthetic events and events from servers that omit `age`.
 *  - Both `getTs()` and `localTimestamp` must be finite numbers.
 *  - Latest sample wins; no smoothing or averaging. A single bad sample
 *    is harmless because the next live event will overwrite it. For our
 *    use case (call-membership expiry windows measured in hours) the
 *    occasional network-latency-biased sample is well within tolerance.
 */
export interface ServerTimeTracker {
	/**
	 * Update the offset from a server-delivered event. Returns true when
	 * the event was eligible and a sample was consumed (regardless of
	 * whether the offset changed), false when the event was skipped
	 * (missing/invalid `unsigned.age`, non-finite timestamps, etc.).
	 * Callers that need to react to a material offset change should
	 * snapshot `getOffsetMs()` before/after the call and compare.
	 */
	sampleFromEvent(event: MatrixEvent): boolean;
	/** Server-clock approximation: `Date.now() + offsetMs`. */
	now(): number;
	/** Current offset in ms (server - client). Zero until first sample. */
	getOffsetMs(): number;
}

/**
 * Threshold above which an offset change is considered material and worth
 * recomputing call-active state for. 1 second is well below the granularity
 * of call-membership expiry (minutes-to-hours) while filtering out
 * sub-second jitter from network latency on every sample.
 */
export const MATERIAL_OFFSET_CHANGE_MS = 1000;

export function createServerTimeTracker(): ServerTimeTracker {
	let offsetMs = 0;

	function sampleFromEvent(event: MatrixEvent): boolean {
		const age = event.event?.unsigned?.age;
		if (typeof age !== "number" || !Number.isFinite(age)) return false;
		const ts = event.getTs();
		const local = event.localTimestamp;
		if (!Number.isFinite(ts) || !Number.isFinite(local)) return false;
		offsetMs = ts - local;
		return true;
	}

	return {
		sampleFromEvent,
		now: () => Date.now() + offsetMs,
		getOffsetMs: () => offsetMs,
	};
}
