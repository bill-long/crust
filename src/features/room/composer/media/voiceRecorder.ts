import { createSignal } from "solid-js";
import type { VoiceMetadata } from "./types";

/**
 * Microphone capture for MSC3245 voice notes: wraps MediaRecorder with an
 * AnalyserNode side-channel that samples amplitudes for the MSC3246
 * waveform, and tracks elapsed time for the recording UI.
 *
 * Kept UI-free (signals + actions) so the composer owns presentation and
 * a browser test can drive it over a synthetic stream. All platform
 * resources (stream tracks, AudioContext, timers) are released on
 * stop/cancel/dispose - a leaked track keeps the OS mic indicator on.
 */

/** Recording auto-stops here (delivered, not discarded): an unbounded
 *  recording grows memory without limit and is never intentional. */
export const MAX_RECORDING_MS = 15 * 60 * 1000;

/** Amplitude sampling cadence while recording. */
const SAMPLE_INTERVAL_MS = 100;
/** Wire waveform sample budget (Element sends ~100). */
const WIRE_WAVEFORM_SAMPLES = 100;
/** MSC3246 amplitude scale. */
const WAVEFORM_SCALE = 1024;

/** Recorder container preference: Opus-in-Ogg (what Element sends) with
 *  WebM fallbacks for browsers that can't mux Ogg (Chromium). */
const MIME_PREFERENCES = [
	"audio/ogg;codecs=opus",
	"audio/webm;codecs=opus",
	"audio/webm",
	"audio/mp4",
];

export interface VoiceRecording {
	blob: Blob;
	/** Container mimetype without codec parameters (event `info.mimetype`). */
	mimetype: string;
	voice: VoiceMetadata;
}

export function isVoiceRecordingSupported(): boolean {
	return (
		typeof MediaRecorder !== "undefined" &&
		typeof AudioContext !== "undefined" &&
		typeof navigator !== "undefined" &&
		!!navigator.mediaDevices?.getUserMedia
	);
}

function pickMimeType(): string | undefined {
	for (const candidate of MIME_PREFERENCES) {
		if (MediaRecorder.isTypeSupported(candidate)) return candidate;
	}
	return undefined;
}

/** Downsample captured 0..1 amplitudes to the wire budget and scale to
 *  MSC3246 integers. Exported for tests. */
export function toWireWaveform(amplitudes: readonly number[]): number[] {
	if (amplitudes.length === 0) return [];
	const count = Math.min(amplitudes.length, WIRE_WAVEFORM_SAMPLES);
	const wire: number[] = [];
	for (let i = 0; i < count; i++) {
		const start = Math.floor((i * amplitudes.length) / count);
		const end = Math.max(
			start + 1,
			Math.floor(((i + 1) * amplitudes.length) / count),
		);
		let max = 0;
		for (let j = start; j < end; j++) {
			if (amplitudes[j] > max) max = amplitudes[j];
		}
		wire.push(Math.round(Math.min(Math.max(max, 0), 1) * WAVEFORM_SCALE));
	}
	return wire;
}

export interface VoiceRecorder {
	/** True while capturing. */
	recording: () => boolean;
	/** Milliseconds recorded so far (UI timer). */
	elapsedMs: () => number;
	/** Live 0..1 amplitude samples for the recording UI's mini waveform. */
	liveAmplitudes: () => number[];
	/**
	 * Request the microphone and start capturing. Throws when the user
	 * denies permission or no capture path is available - callers surface
	 * that as UI. `getStream` is injectable for tests (a synthetic
	 * oscillator stream needs no permission prompt).
	 */
	start(): Promise<void>;
	/** Stop and return the finished recording, or null if not recording. */
	stop(): Promise<VoiceRecording | null>;
	/** Stop and discard everything. */
	cancel(): void;
	/** Cancel + release everything (component unmount). */
	dispose(): void;
}

export interface VoiceRecorderOptions {
	/** Called when MAX_RECORDING_MS elapses; the recording keeps its data
	 *  and the callback decides (the composer sends it). */
	onMaxDuration?: () => void;
	/** Called when the recording is cut short from outside (mic unplugged,
	 *  permission revoked, recorder error). Captured audio up to that point
	 *  is preserved and retrievable via stop(). */
	onInterrupted?: () => void;
	/** Test seam: replaces getUserMedia. */
	getStream?: () => Promise<MediaStream>;
}

export function createVoiceRecorder(
	options?: VoiceRecorderOptions,
): VoiceRecorder {
	const [recording, setRecording] = createSignal(false);
	const [elapsedMs, setElapsedMs] = createSignal(0);
	const [liveAmplitudes, setLiveAmplitudes] = createSignal<number[]>([]);

	let stream: MediaStream | null = null;
	let recorder: MediaRecorder | null = null;
	let audioContext: AudioContext | null = null;
	let analyser: AnalyserNode | null = null;
	let chunks: Blob[] = [];
	let amplitudes: number[] = [];
	let startedAt = 0;
	let sampleTimer: ReturnType<typeof setInterval> | null = null;
	let maxTimer: ReturnType<typeof setTimeout> | null = null;
	/** Guards double stop/cancel and stale async completions. */
	let session = 0;
	/**
	 * Single-flight stop: concurrent stop() calls (double-click, the
	 * max-duration auto-stop racing a manual send) share one promise
	 * instead of clobbering each other's onstop resolver. Also blocks
	 * cancel() from clearing chunks under an in-progress stop - a send the
	 * user already initiated must deliver even if a room switch cancels
	 * the recorder mid-flight.
	 */
	let stopInFlight: Promise<VoiceRecording | null> | null = null;

	function releaseResources(): void {
		if (sampleTimer !== null) {
			clearInterval(sampleTimer);
			sampleTimer = null;
		}
		if (maxTimer !== null) {
			clearTimeout(maxTimer);
			maxTimer = null;
		}
		for (const track of stream?.getTracks() ?? []) {
			// Spec-wise a local stop() fires no "ended" event, but detach the
			// interruption listener first anyway so teardown can never be
			// mistaken for an external interruption.
			track.removeEventListener("ended", onExternalInterruption);
			track.stop();
		}
		stream = null;
		analyser = null;
		void audioContext?.close().catch(() => {});
		audioContext = null;
		recorder = null;
		// Release the capture buffers: after a long note they can hold
		// megabytes that would otherwise stay referenced by this closure
		// until the next start(). stop() builds its Blob before this runs
		// (the Blob owns its own copy of the data).
		chunks = [];
		amplitudes = [];
		setLiveAmplitudes([]);
		setRecording(false);
	}

	/** Reused across ticks: allocating 1KB per 100ms sample adds avoidable
	 *  GC pressure over a long recording. Sized on start(). */
	let sampleBuffer = new Uint8Array(0);

	function sampleAmplitude(): void {
		if (!analyser) return;
		if (sampleBuffer.length !== analyser.fftSize) {
			sampleBuffer = new Uint8Array(analyser.fftSize);
		}
		const data = sampleBuffer;
		analyser.getByteTimeDomainData(data);
		// Peak deviation from the 128 midpoint, normalized to 0..1.
		let peak = 0;
		for (const v of data) {
			const dev = Math.abs(v - 128) / 128;
			if (dev > peak) peak = dev;
		}
		amplitudes.push(peak);
		setLiveAmplitudes(amplitudes.slice(-30));
		setElapsedMs(performance.now() - startedAt);
	}

	/** Single-flight start: a double-click on the mic button must not
	 *  spawn a second getUserMedia request (a second permission prompt);
	 *  concurrent callers share the first call's outcome. */
	let startInFlight: Promise<void> | null = null;

	function start(): Promise<void> {
		if (startInFlight) return startInFlight;
		if (recording()) return Promise.resolve();
		startInFlight = doStart().finally(() => {
			startInFlight = null;
		});
		return startInFlight;
	}

	async function doStart(): Promise<void> {
		const mySession = ++session;
		const getStream =
			options?.getStream ??
			(() => navigator.mediaDevices.getUserMedia({ audio: true }));
		const acquired = await getStream();
		// A cancel/dispose while the permission prompt was open: release
		// the just-acquired stream instead of leaking a live mic track.
		if (mySession !== session) {
			for (const track of acquired.getTracks()) track.stop();
			return;
		}
		// Any failure past this point (context limit, MediaRecorder
		// constructor) must release the acquired mic - a leaked live track
		// keeps the OS mic indicator lit with no recording UI in sight.
		try {
			stream = acquired;
			chunks = [];
			amplitudes = [];
			setLiveAmplitudes([]);
			setElapsedMs(0);

			audioContext = new AudioContext();
			// Strict-autoplay browsers can start the context suspended even
			// though start() runs from a user gesture; a suspended context
			// would flatline the analyser. Resume is cheap and idempotent.
			if (audioContext.state === "suspended") {
				void audioContext.resume().catch(() => {});
			}
			const source = audioContext.createMediaStreamSource(acquired);
			analyser = audioContext.createAnalyser();
			analyser.fftSize = 1024;
			source.connect(analyser);
			// Audio graphs render destination-driven: without a path to the
			// context destination the analyser subgraph may never process.
			// Route through a zero-gain node so it renders silently.
			const mute = audioContext.createGain();
			mute.gain.value = 0;
			analyser.connect(mute);
			mute.connect(audioContext.destination);

			const mimeType = pickMimeType();
			recorder = new MediaRecorder(
				acquired,
				mimeType ? { mimeType } : undefined,
			);
			recorder.ondataavailable = (e) => {
				if (e.data.size > 0) chunks.push(e.data);
			};
			// A recording cut short from outside (mic unplugged, permission
			// revoked, recorder failure): keep the captured chunks - stop()
			// still delivers them - but tell the owner so the UI reacts.
			// stop() detects the inactive recorder and skips waiting.
			recorder.onerror = onExternalInterruption;
			for (const track of acquired.getTracks()) {
				track.addEventListener("ended", onExternalInterruption);
			}
			recorder.start();
			startedAt = performance.now();
			sampleTimer = setInterval(sampleAmplitude, SAMPLE_INTERVAL_MS);
			maxTimer = setTimeout(() => {
				// stop() clears this timer only after its async settle; a
				// fire inside that window (or from a caller without the
				// composer's own stopping guard) must not re-enter a
				// delivery that is already under way.
				if (!recording() || stopInFlight) return;
				options?.onMaxDuration?.();
			}, MAX_RECORDING_MS);
			setRecording(true);
		} catch (e) {
			// `stream = acquired` was the try's first statement, so
			// releaseResources() stops the acquired mic tracks too.
			releaseResources();
			throw e;
		}
	}

	function onExternalInterruption(): void {
		// A stop() in flight will finalize normally; otherwise notify the
		// owner (it typically stops-and-sends what was captured).
		if (stopInFlight) return;
		if (!recording()) return;
		options?.onInterrupted?.();
	}

	function stop(): Promise<VoiceRecording | null> {
		// Single-flight: a second stop (double-click, auto-stop racing a
		// manual send) shares the first call's outcome.
		if (stopInFlight) return stopInFlight;
		const active = recorder;
		if (!active || !recording()) return Promise.resolve(null);
		stopInFlight = (async () => {
			try {
				session++;
				const durationMs = Math.round(performance.now() - startedAt);
				const mimeType = active.mimeType || "audio/webm";
				// Wait for the recorder to settle before reading `chunks`: the
				// final dataavailable is a QUEUED task dispatched after state
				// flips to "inactive", so reading chunks the moment the state
				// reads inactive can miss the last (often the only) chunk.
				const settled = new Promise<void>((resolve) => {
					// When the recorder is (or goes) active->stopped after this
					// handler is attached, onstop reliably fires and everything
					// before it (the final dataavailable) has been delivered.
					active.onstop = () => resolve();
					if (active.state === "inactive") {
						// Already stopped: the stop event may have fired BEFORE
						// the handler above was attached (it will never fire
						// again). A macrotask fallback runs after any
						// still-queued final dataavailable/stop tasks, so the
						// last chunk lands either way and the await can't hang.
						setTimeout(resolve, 0);
					}
				});
				if (active.state !== "inactive") {
					try {
						active.stop();
					} catch {
						// Raced into inactive after the handler was attached;
						// the already-queued stop event resolves `settled`.
					}
				}
				await settled;
				const blob = new Blob(chunks, { type: mimeType });
				const waveform = toWireWaveform(amplitudes);
				if (blob.size === 0) return null;
				return {
					blob,
					// Strip codec parameters: event mimetypes carry the container.
					mimetype: mimeType.split(";")[0],
					voice: { durationMs, waveform },
				};
			} finally {
				releaseResources();
				stopInFlight = null;
			}
		})();
		return stopInFlight;
	}

	function cancel(): void {
		// Never clear state under an in-flight stop: the user already
		// initiated that send (e.g. a room switch right after pressing
		// send), and the pinned-room delivery must complete.
		if (stopInFlight) return;
		session++;
		if (recorder) {
			// Detach ALL handlers, not just onstop: the cancelled recorder
			// flushes its final chunk asynchronously, and a still-attached
			// ondataavailable would push the discarded clip's bytes into
			// `chunks` after a new start() has begun filling it.
			recorder.onstop = null;
			recorder.ondataavailable = null;
			recorder.onerror = null;
			if (recorder.state !== "inactive") {
				try {
					recorder.stop();
				} catch {
					// Already stopped.
				}
			}
		}
		setElapsedMs(0);
		// releaseResources also clears the capture buffers.
		releaseResources();
	}

	return {
		recording,
		elapsedMs,
		liveAmplitudes,
		start,
		stop,
		cancel,
		dispose: cancel,
	};
}
