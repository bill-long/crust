import { afterEach, describe, expect, it } from "vitest";
import {
	createVoiceRecorder,
	isVoiceRecordingSupported,
	toWireWaveform,
	type VoiceRecorder,
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

function makeRecorderOverTone(): VoiceRecorder {
	const ctx = new AudioContext();
	// Headless Chromium starts contexts suspended (no user gesture); a
	// suspended source context would produce a silent stream.
	void ctx.resume();
	const osc = ctx.createOscillator();
	const destination = ctx.createMediaStreamDestination();
	osc.frequency.value = 440;
	osc.connect(destination);
	osc.start();
	const recorder = createVoiceRecorder({
		getStream: () => Promise.resolve(destination.stream),
	});
	active = { recorder, ctx };
	return recorder;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("createVoiceRecorder (browser)", () => {
	it("is supported in a real browser", () => {
		expect(isVoiceRecordingSupported()).toBe(true);
	});

	it("records a clip with sane metadata", async () => {
		const recorder = makeRecorderOverTone();
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
		const recorder = makeRecorderOverTone();
		await recorder.start();
		await sleep(200);
		recorder.cancel();
		expect(recorder.recording()).toBe(false);
		expect(recorder.elapsedMs()).toBe(0);
		// A stop after cancel has nothing to deliver.
		expect(await recorder.stop()).toBeNull();
	});

	it("the recorded clip decodes as real audio", async () => {
		const recorder = makeRecorderOverTone();
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
