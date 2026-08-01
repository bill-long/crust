/**
 * Notification sound utility.
 *
 * Synthesises a short two-note chime via the Web Audio API so the app
 * needs no audio asset files.  The AudioContext singleton is created
 * lazily and primed on the first trusted user gesture to satisfy
 * browser autoplay policies.
 */

let ctx: AudioContext | null = null;
let primed = false;
let lastPlayTime = 0;
// Separate debounce clock for the voice-channel presence cues. Sharing
// `lastPlayTime` with the message chime would let an incoming message
// swallow a join cue that lands in the same window (and vice versa) —
// they are unrelated signals and must not suppress each other.
let lastPresencePlayTime = 0;
let primeHandler: (() => void) | null = null;

/** Minimum gap between consecutive plays (ms). */
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
	lastPresencePlayTime = 0;
}

/**
 * Play a short two-note notification chime (~200 ms).
 *
 * All errors are caught internally — callers never need to handle
 * rejections.
 */
export function playNotificationSound(): void {
	const now = performance.now();
	if (now - lastPlayTime < DEBOUNCE_MS) return;
	lastPlayTime = now;

	void (async () => {
		try {
			if (!(await ensureRunning())) return;
			// biome-ignore lint/style/noNonNullAssertion: ensureRunning() guarantees ctx is set
			const c = ctx!;
			const t = c.currentTime;

			// Note 1 — A5 (880 Hz), 80 ms
			playTone(c, 880, t, 0.08);
			// Note 2 — C6 (1047 Hz), 100 ms, offset 60 ms
			playTone(c, 1047, t + 0.06, 0.1);
		} catch {
			// Best-effort — silently ignore playback failures
		}
	})();
}

// Voice-channel presence cues. Deliberately lower and wider-intervalled than
// the message chime (880 -> 1047) so a join can't be mistaken for a new
// message: D5 -> A5 rising for join, the same pair falling for leave.
const PRESENCE_LOW_HZ = 587;
const PRESENCE_HIGH_HZ = 880;
/** Gap between a join and a leave cue played from the same flush (seconds). */
const PRESENCE_STAGGER_S = 0.25;

/**
 * Play the voice-channel presence cue(s) for one coalesced roster change:
 * a rising two-note cue for joins, a falling one for leaves.
 *
 * Takes both directions in a single call because a join and a leave can land
 * in the same coalescing window; they are then staggered rather than played
 * on top of each other, and the debounce applies once to the pair instead of
 * the second cue suppressing the first.
 *
 * All errors are caught internally — callers never need to handle rejections.
 */
export function playPresenceCue(opts: { join: boolean; leave: boolean }): void {
	if (!opts.join && !opts.leave) return;

	const now = performance.now();
	if (now - lastPresencePlayTime < DEBOUNCE_MS) return;
	lastPresencePlayTime = now;

	void (async () => {
		try {
			if (!(await ensureRunning())) return;
			// biome-ignore lint/style/noNonNullAssertion: ensureRunning() guarantees ctx is set
			const c = ctx!;
			const t = c.currentTime;

			if (opts.join) {
				playTone(c, PRESENCE_LOW_HZ, t, 0.08);
				playTone(c, PRESENCE_HIGH_HZ, t + 0.06, 0.1);
			}
			// Offset only when a join already occupies the head of the window.
			const leaveStart = t + (opts.join ? PRESENCE_STAGGER_S : 0);
			if (opts.leave) {
				playTone(c, PRESENCE_HIGH_HZ, leaveStart, 0.08);
				playTone(c, PRESENCE_LOW_HZ, leaveStart + 0.06, 0.1);
			}
		} catch {
			// Best-effort — silently ignore playback failures
		}
	})();
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
