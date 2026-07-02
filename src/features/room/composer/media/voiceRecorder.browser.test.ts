import { afterEach, describe, expect, it } from "vitest";
import {
	createVoiceRecorder,
	isVoiceRecordingSupported,
	toWireWaveform,
	type VoiceRecorder,
	type VoiceRecorderOptions,
} from "./voiceRecorder";

/**
 * Real-browser recorder tests: MediaRecorder + AnalyserNode over a
 * synthetic oscillator stream (no mic, no permission prompt) via the
 * recorder's getStream test seam.
 */

let active: { recorder: VoiceRecorder; ctx: AudioContext } | null = null;

afterEach(() => {
	active?.recorder.dispose();
	void active?.ctx.close().catch(() => {});
	active = null;
});

function makeRecorderOverTone(
	options?: Omit<VoiceRecorderOptions, "getStream">,
): { recorder: VoiceRecorder; stream: MediaStream } {
	const ctx = new AudioContext();
	// Headless Chromium starts contexts suspended (no user gesture); a
	// suspended source context would produce a silent stream.
	void ctx.resume().catch(() => {});
	const osc = ctx.createOscillator();
	const destination = ctx.createMediaStreamDestination();
	osc.frequency.value = 440;
	osc.connect(destination);
	osc.start();
	const recorder = createVoiceRecorder({
		...options,
		getStream: () => Promise.resolve(destination.stream),
	});
	active = { recorder, ctx };
	return { recorder, stream: destination.stream };
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("createVoiceRecorder (browser)", () => {
	it("is supported in a real browser", () => {
		expect(isVoiceRecordingSupported()).toBe(true);
	});

	it("records a clip with sane metadata", async () => {
		const { recorder } = makeRecorderOverTone();
		await recorder.start();
		expect(recorder.recording()).toBe(true);
		await sleep(500);
		expect(recorder.elapsedMs()).toBeGreaterThan(300);
		expect(recorder.liveAmplitudes().length).toBeGreaterThan(0);

		const result = await recorder.stop();
		expect(recorder.recording()).toBe(false);
		expect(result).not.toBeNull();
		if (!result) throw new Error("unreachable");
		expect(result.blob.size).toBeGreaterThan(0);
		// Container type without codec parameters.
		expect(result.mimetype).toMatch(/^audio\/[a-z0-9.+-]+$/);
		expect(result.mimetype).not.toContain(";");
		expect(result.voice.durationMs).toBeGreaterThan(300);
		expect(result.voice.durationMs).toBeLessThan(5_000);
		// A constant tone must produce non-zero MSC3246 amplitudes.
		expect(result.voice.waveform.length).toBeGreaterThan(0);
		expect(result.voice.waveform.length).toBeLessThanOrEqual(100);
		expect(Math.max(...result.voice.waveform)).toBeGreaterThan(0);
		for (const v of result.voice.waveform) {
			expect(Number.isInteger(v)).toBe(true);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1024);
		}
	});

	it("cancel discards the recording and stops the tracks", async () => {
		const { recorder } = makeRecorderOverTone();
		await recorder.start();
		await sleep(200);
		recorder.cancel();
		expect(recorder.recording()).toBe(false);
		expect(recorder.elapsedMs()).toBe(0);
		// A stop after cancel has nothing to deliver.
		expect(await recorder.stop()).toBeNull();
	});

	it("concurrent start() calls share one stream acquisition (single-flight)", async () => {
		const ctx = new AudioContext();
		void ctx.resume().catch(() => {});
		let acquisitions = 0;
		const recorder = createVoiceRecorder({
			getStream: () => {
				acquisitions++;
				const osc = ctx.createOscillator();
				const destination = ctx.createMediaStreamDestination();
				osc.connect(destination);
				osc.start();
				return Promise.resolve(destination.stream);
			},
		});
		active = { recorder, ctx };
		// A double-click on the mic button must not spawn a second
		// getUserMedia request (a second permission prompt).
		await Promise.all([recorder.start(), recorder.start()]);
		expect(acquisitions).toBe(1);
		expect(recorder.recording()).toBe(true);
	});

	it("concurrent stop() calls share one recording (single-flight)", async () => {
		const { recorder } = makeRecorderOverTone();
		await recorder.start();
		await sleep(300);
		// Double-click on send, or the max-duration auto-stop racing a
		// manual send: both callers must get the same delivered clip, not
		// have the second clobber the first's onstop resolver.
		const [a, b] = await Promise.all([recorder.stop(), recorder.stop()]);
		expect(a).not.toBeNull();
		expect(b).toBe(a);
	});

	it("cancel during an in-flight stop does not discard the recording", async () => {
		const { recorder } = makeRecorderOverTone();
		await recorder.start();
		await sleep(300);
		// A room switch cancels the recorder right after the user pressed
		// send; the already-initiated stop must still deliver its audio.
		const pending = recorder.stop();
		recorder.cancel();
		const result = await pending;
		expect(result).not.toBeNull();
		expect(result?.blob.size).toBeGreaterThan(0);
		expect(recorder.recording()).toBe(false);
	});

	it("notifies the owner when a track ends externally and still delivers", async () => {
		let interruptions = 0;
		const { recorder, stream } = makeRecorderOverTone({
			onInterrupted: () => {
				interruptions++;
			},
		});
		await recorder.start();
		await sleep(300);
		// Mic unplugged / permission revoked surfaces as "ended" on the
		// track. The owner is told once, and the captured audio survives.
		for (const track of stream.getTracks()) {
			track.dispatchEvent(new Event("ended"));
		}
		expect(interruptions).toBe(1);
		const result = await recorder.stop();
		expect(result).not.toBeNull();
		expect(result?.blob.size).toBeGreaterThan(0);
	});

	it("delivers the full clip when stop() races a spontaneous recorder stop", async () => {
		const { recorder, stream } = makeRecorderOverTone();
		await recorder.start();
		await sleep(300);
		// Interruption immediately followed by stop() (the composer's
		// onInterrupted path): with no timeslice the recorder's ONLY
		// dataavailable is a queued task dispatched after its state flips
		// to inactive - reading chunks too early yields an empty blob.
		for (const track of stream.getTracks()) track.stop();
		const result = await recorder.stop();
		expect(result).not.toBeNull();
		expect(result?.blob.size).toBeGreaterThan(0);
	});

	it("stop() resolves after the recorder already stopped spontaneously", async () => {
		const { recorder, stream } = makeRecorderOverTone();
		await recorder.start();
		await sleep(300);
		// Stopping the source track makes MediaRecorder stop on its own; a
		// later stop() must not hang awaiting an onstop that already fired,
		// and the partial capture still delivers.
		for (const track of stream.getTracks()) track.stop();
		await sleep(200);
		const result = await recorder.stop();
		expect(result).not.toBeNull();
		expect(result?.blob.size).toBeGreaterThan(0);
	});

	it("the recorded clip decodes as real audio", async () => {
		const { recorder } = makeRecorderOverTone();
		await recorder.start();
		await sleep(500);
		const result = await recorder.stop();
		if (!result) throw new Error("no recording");
		const ctx = new AudioContext();
		const decoded = await ctx.decodeAudioData(await result.blob.arrayBuffer());
		expect(decoded.duration).toBeGreaterThan(0.2);
		await ctx.close();
	});
});

describe("toWireWaveform", () => {
	it("scales 0..1 amplitudes to MSC3246 integers", () => {
		expect(toWireWaveform([0, 0.5, 1])).toEqual([0, 512, 1024]);
	});

	it("downsamples long captures to the wire budget (bucket max)", () => {
		const long = Array.from({ length: 1000 }, (_, i) => (i === 999 ? 1 : 0.25));
		const wire = toWireWaveform(long);
		expect(wire.length).toBe(100);
		// The peak in the final bucket survives downsampling.
		expect(wire[99]).toBe(1024);
	});

	it("clamps out-of-range values and handles empty input", () => {
		expect(toWireWaveform([-1, 2])).toEqual([0, 1024]);
		expect(toWireWaveform([])).toEqual([]);
	});
});
