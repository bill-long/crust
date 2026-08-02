/**
 * Notification sound utility.
 *
 * Synthesises the app's notification sounds via the Web Audio API, so they
 * need no audio asset files: the incoming-message chime and the voice-channel
 * join/leave presence cues. Those two cues are this module's whole scope -
 * media playback, call audio and mic capture each own their own audio
 * elsewhere, so treat neither this header nor `closeNotificationSound` as
 * covering the app's audio as a whole. The AudioContext singleton here is
 * created lazily and primed on the first trusted user gesture to satisfy
 * browser autoplay policies.
 *
 * All sounds go through `playNotes`, which owns the autoplay contract, the
 * envelope and the failure handling, and which serialises playback so two
 * sounds never overlap into a garbled, double-gain blur. Rate limiting is
 * per-caller and deliberately NOT uniform: the message chime debounces on
 * `DEBOUNCE_MS`, while the presence cues are undebounced here because their
 * caller already coalesces (see `playPresenceCue`).
 */

let ctx: AudioContext | null = null;
let primed = false;
let lastPlayTime = 0;
let primeHandler: (() => void) | null = null;

/** Minimum gap between consecutive message chimes (ms). */
const DEBOUNCE_MS = 500;

function getContext(): AudioContext | null {
	if (ctx) return ctx;
	try {
		ctx = new AudioContext();
	} catch {
		// AudioContext unavailable (SSR, restricted env)
	}
	return ctx;
}

/**
 * Resume the AudioContext if suspended.  Returns true when the
 * context is usable.
 */
async function ensureRunning(): Promise<boolean> {
	const c = getContext();
	if (!c) return false;
	if (c.state === "suspended") {
		try {
			await c.resume();
		} catch {
			return false;
		}
	}
	return c.state === "running";
}

/**
 * Register a one-time listener that resumes (primes) the AudioContext
 * on the first trusted user gesture.  Call once at hook setup time.
 */
export function primeAudioContext(): void {
	if (primed) return;
	if (typeof window === "undefined") return;
	primed = true;

	const handler = (): void => {
		void ensureRunning();
		window.removeEventListener("pointerdown", handler, true);
		window.removeEventListener("keydown", handler, true);
		primeHandler = null;
	};
	primeHandler = handler;

	window.addEventListener("pointerdown", handler, {
		capture: true,
		once: true,
	});
	window.addEventListener("keydown", handler, { capture: true, once: true });
}

/**
 * Close the AudioContext and release hardware audio resources.
 * Call on logout or account switch.
 */
export function closeNotificationSound(): void {
	if (primeHandler) {
		window.removeEventListener("pointerdown", primeHandler, true);
		window.removeEventListener("keydown", primeHandler, true);
		primeHandler = null;
	}
	if (ctx) {
		void ctx.close().catch(() => {});
		ctx = null;
	}
	primed = false;
	lastPlayTime = 0;
	// The next context starts its clock at 0, so a carried-over end time from
	// the old one would sit far in the future and mute everything.
	nextFreeTime = 0;
}

/** One scheduled note, relative to the moment playback starts. */
interface Note {
	hz: number;
	/** Offset from the start of the cue (seconds). */
	at: number;
	/** Duration (seconds). */
	dur: number;
}

/**
 * AudioContext-clock time at which the last scheduled sound finishes. Used to
 * serialise playback: a sound arriving while another is still sounding starts
 * after it rather than on top of it. Without this, any caller whose rate limit
 * is shorter than a sound's own duration produces overlapping oscillators at
 * summed gain - and the presence cues, whose 250 ms coalescing window is
 * shorter than a 410 ms join+leave pair, are exactly such a caller.
 */
let nextFreeTime = 0;

/**
 * Cap on how far ahead playback may be queued (seconds). Past this the roster
 * is churning faster than the cues can sound, so the extra beeps convey
 * nothing and are dropped rather than piling into an ever-lengthening queue
 * that lags further behind reality with each one.
 */
const MAX_QUEUE_AHEAD_S = 1;

/**
 * Resume the context and schedule `notes`, starting after any sound still
 * playing. Shared by every sound this module emits so the autoplay contract,
 * the failure handling and the envelope live in exactly one place.
 *
 * All errors are caught internally - callers never need to handle rejections.
 */
function playNotes(notes: readonly Note[]): void {
	void (async () => {
		try {
			if (!(await ensureRunning())) return;
			// biome-ignore lint/style/noNonNullAssertion: ensureRunning() guarantees ctx is set
			const c = ctx!;
			const start = Math.max(c.currentTime, nextFreeTime);
			if (start - c.currentTime > MAX_QUEUE_AHEAD_S) return;
			let end = start;
			for (const n of notes) {
				playTone(c, n.hz, start + n.at, n.dur);
				end = Math.max(end, start + n.at + n.dur);
			}
			nextFreeTime = end;
		} catch {
			// Best-effort - silently ignore playback failures
		}
	})();
}

/** Play a short two-note notification chime (~200 ms). */
export function playNotificationSound(): void {
	const now = performance.now();
	if (now - lastPlayTime < DEBOUNCE_MS) return;
	lastPlayTime = now;

	playNotes([
		// A5 (880 Hz), then C6 (1047 Hz) offset 60 ms
		{ hz: 880, at: 0, dur: 0.08 },
		{ hz: 1047, at: 0.06, dur: 0.1 },
	]);
}

// Voice-channel presence cues. Deliberately a register below the message
// chime (880 -> 1047) and sharing no frequency with it, so a join can't be
// mistaken for a new message and the two never sum on a common tone when
// they land together: C5 -> G5 rising for join, the same pair falling for
// leave.
const PRESENCE_LOW_HZ = 523;
const PRESENCE_HIGH_HZ = 784;
/** Gap between a join and a leave cue played from the same flush (seconds). */
const PRESENCE_STAGGER_S = 0.25;

/**
 * Play the voice-channel presence cue(s) for one coalesced roster change:
 * a rising two-note cue for joins, a falling one for leaves.
 *
 * Takes both directions in a single call because a join and a leave can land
 * in the same coalescing window; they are then staggered rather than played
 * on top of each other.
 *
 * Deliberately undebounced. `callPresenceCue` already coalesces roster churn
 * into at most one call per coalescing window and consumes the delta as it
 * does so, so a debounce here could only discard a cue that has already been
 * folded into the baseline and can never be replayed. That window is shorter
 * than a join+leave pair takes to sound, so overlap is prevented by
 * `playNotes` serialising playback rather than by a rate limit here.
 */
export function playPresenceCue(opts: { join: boolean; leave: boolean }): void {
	const notes: Note[] = [];
	if (opts.join) {
		notes.push(
			{ hz: PRESENCE_LOW_HZ, at: 0, dur: 0.08 },
			{ hz: PRESENCE_HIGH_HZ, at: 0.06, dur: 0.1 },
		);
	}
	if (opts.leave) {
		// Offset only when a join already occupies the head of the window.
		const at = opts.join ? PRESENCE_STAGGER_S : 0;
		notes.push(
			{ hz: PRESENCE_HIGH_HZ, at, dur: 0.08 },
			{ hz: PRESENCE_LOW_HZ, at: at + 0.06, dur: 0.1 },
		);
	}
	if (notes.length === 0) return;
	playNotes(notes);
}

function playTone(
	c: AudioContext,
	freq: number,
	start: number,
	duration: number,
): void {
	const osc = c.createOscillator();
	const gain = c.createGain();
	osc.type = "sine";
	osc.frequency.value = freq;

	// Smooth envelope: quick attack, short sustain, fade out
	const attack = 0.01;
	const release = duration * 0.4;
	gain.gain.setValueAtTime(0, start);
	gain.gain.linearRampToValueAtTime(0.15, start + attack);
	gain.gain.setValueAtTime(0.15, start + duration - release);
	gain.gain.linearRampToValueAtTime(0, start + duration);

	osc.connect(gain);
	gain.connect(c.destination);
	osc.start(start);
	osc.stop(start + duration);

	osc.addEventListener(
		"ended",
		() => {
			osc.disconnect();
			gain.disconnect();
		},
		{ once: true },
	);
}
