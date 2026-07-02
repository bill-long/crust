/**
 * MSC3245 voice-message wire helpers, shared by the timeline projection,
 * the notification builders, and (via pushCopy.ts) the service worker.
 *
 * Deliberately dependency-free: matrix-js-sdk 41.4.0 ships no MSC3245
 * helpers, and anything pushCopy pulls in must stay SDK-free. The wire
 * shape matches what Element sends today (msgtype m.audio plus the two
 * unstable marker blocks below).
 */

/** Rendering-hint marker: present (as an object) on voice messages. */
export const MSC3245_VOICE_KEY = "org.matrix.msc3245.voice";
/** MSC1767 audio block carrying `duration` (ms) and the MSC3246
 *  `waveform` (integer amplitudes in 0..1024). */
export const MSC1767_AUDIO_KEY = "org.matrix.msc1767.audio";

/** Defensive cap on accepted waveform samples: Element sends ~100; a
 *  hostile event could carry millions. Longer arrays are resampled by the
 *  renderer anyway, so truncation loses nothing visible. */
const MAX_WAVEFORM_SAMPLES = 1024;

/** Defensive cap on the accepted duration (6 hours, far beyond any real
 *  voice note): a hostile duration like 1e12 ms would otherwise render an
 *  enormous time string. Above the cap the duration is treated as
 *  unreadable (null), so the renderer falls back to the decoded length. */
const MAX_DURATION_MS = 6 * 60 * 60 * 1000;

/** MSC3246 amplitude scale: integers 0..1024. */
const WAVEFORM_SCALE = 1024;

/**
 * True when event content is an MSC3245 voice message: an `m.audio`
 * message carrying the voice rendering-hint block.
 */
export function isVoiceMessageContent(content: unknown): boolean {
	if (typeof content !== "object" || content === null) return false;
	const record = content as Record<string, unknown>;
	if (record.msgtype !== "m.audio") return false;
	const marker = record[MSC3245_VOICE_KEY];
	return typeof marker === "object" && marker !== null;
}

export interface VoiceInfo {
	/** Playback length in milliseconds, or null when not readable. */
	durationMs: number | null;
	/**
	 * Amplitude samples normalized to 0..1 floats (wire values are
	 * MSC3246 integers in 0..1024; out-of-range values are clamped).
	 * Null when the event carries no usable waveform.
	 */
	waveform: number[] | null;
}

/**
 * Extract duration and waveform from voice-message content. Tolerant of
 * missing/malformed blocks (both fields are optional per the MSC and some
 * clients omit the waveform): each field is validated independently and
 * nulled when unusable, never throwing on hostile shapes.
 */
export function parseVoiceInfo(content: unknown): VoiceInfo {
	if (typeof content !== "object" || content === null) {
		return { durationMs: null, waveform: null };
	}
	const record = content as Record<string, unknown>;
	const audio = record[MSC1767_AUDIO_KEY];
	const audioBlock =
		typeof audio === "object" && audio !== null
			? (audio as Record<string, unknown>)
			: null;
	const info =
		typeof record.info === "object" && record.info !== null
			? (record.info as Record<string, unknown>)
			: null;

	// Duration: prefer the MSC1767 block, fall back to info.duration.
	const rawDuration = audioBlock?.duration ?? info?.duration;
	const durationMs =
		typeof rawDuration === "number" &&
		Number.isFinite(rawDuration) &&
		rawDuration > 0 &&
		rawDuration <= MAX_DURATION_MS
			? rawDuration
			: null;

	const rawWaveform = audioBlock?.waveform;
	let waveform: number[] | null = null;
	if (Array.isArray(rawWaveform) && rawWaveform.length > 0) {
		const samples: number[] = [];
		for (const value of rawWaveform.slice(0, MAX_WAVEFORM_SAMPLES)) {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				samples.length = 0;
				break;
			}
			samples.push(
				Math.min(Math.max(value, 0), WAVEFORM_SCALE) / WAVEFORM_SCALE,
			);
		}
		if (samples.length > 0) waveform = samples;
	}

	return { durationMs, waveform };
}
