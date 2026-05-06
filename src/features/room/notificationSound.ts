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
	};

	window.addEventListener("pointerdown", handler, {
		capture: true,
		once: true,
	});
	window.addEventListener("keydown", handler, { capture: true, once: true });
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
}
