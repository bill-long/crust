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

	function releaseResources(): void {
		if (sampleTimer !== null) {
			clearInterval(sampleTimer);
			sampleTimer = null;
		}
		if (maxTimer !== null) {
			clearTimeout(maxTimer);
			maxTimer = null;
		}
		for (const track of stream?.getTracks() ?? []) track.stop();
		stream = null;
		analyser = null;
		void audioContext?.close().catch(() => {});
		audioContext = null;
		recorder = null;
		setRecording(false);
	}

	function sampleAmplitude(): void {
		if (!analyser) return;
		const data = new Uint8Array(analyser.fftSize);
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

	async function start(): Promise<void> {
		if (recording()) return;
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

		recorder = new MediaRecorder(
			acquired,
			pickMimeType() ? { mimeType: pickMimeType() } : undefined,
		);
		recorder.ondataavailable = (e) => {
			if (e.data.size > 0) chunks.push(e.data);
		};
		recorder.start();
		startedAt = performance.now();
		sampleTimer = setInterval(sampleAmplitude, SAMPLE_INTERVAL_MS);
		maxTimer = setTimeout(() => {
			options?.onMaxDuration?.();
		}, MAX_RECORDING_MS);
		setRecording(true);
	}

	async function stop(): Promise<VoiceRecording | null> {
		const active = recorder;
		if (!active || !recording()) return null;
		session++;
		const durationMs = Math.round(performance.now() - startedAt);
		const mimeType = active.mimeType || "audio/webm";
		const stopped = new Promise<void>((resolve) => {
			active.onstop = () => resolve();
		});
		active.stop();
		await stopped;
		const blob = new Blob(chunks, { type: mimeType });
		const waveform = toWireWaveform(amplitudes);
		releaseResources();
		if (blob.size === 0) return null;
		return {
			blob,
			// Strip codec parameters: event mimetypes carry the container.
			mimetype: mimeType.split(";")[0],
			voice: { durationMs, waveform },
		};
	}

	function cancel(): void {
		session++;
		if (recorder && recorder.state !== "inactive") {
			recorder.onstop = null;
			try {
				recorder.stop();
			} catch {
				// Already stopped.
			}
		}
		chunks = [];
		amplitudes = [];
		setLiveAmplitudes([]);
		setElapsedMs(0);
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
