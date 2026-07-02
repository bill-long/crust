import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceMessage } from "./VoiceMessage";
import { resetVoicePlaybackContextForTests } from "./voicePlaybackContext";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	// The playback context is a module-level singleton; drop it so one
	// test's AudioContext stub can't leak into the next.
	resetVoicePlaybackContextForTests();
});

function setup(overrides?: Partial<Parameters<typeof VoiceMessage>[0]>) {
	return render(() => (
		<VoiceMessage
			httpUrl="https://example.com/media/voice"
			file={null}
			mimetype="audio/ogg"
			isEncrypted={false}
			durationMs={83_000}
			waveform={[0.1, 0.5, 1]}
			{...overrides}
		/>
	));
}

describe("VoiceMessage", () => {
	it("renders a play button, duration, and waveform bars", () => {
		const { container } = setup();
		expect(screen.getByLabelText("Play voice message")).toBeTruthy();
		expect(screen.getByText("1:23")).toBeTruthy();
		// Wire samples are resampled to a fixed bar count.
		expect(container.querySelectorAll("[aria-hidden] span").length).toBe(40);
	});

	it("fetches nothing until the first play press", () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		setup();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("renders fallback bars when the waveform is missing", () => {
		const { container } = setup({ waveform: null });
		expect(container.querySelectorAll("[aria-hidden] span").length).toBe(40);
	});

	it("shows a dash duration when none is known", () => {
		setup({ durationMs: null });
		expect(screen.getByText("-:--")).toBeTruthy();
	});

	it("formats hour-plus durations as h:mm:ss", () => {
		// The wire accepts up to 6h; "75:03"-style minute overflow is
		// ambiguous next to real m:ss readouts.
		setup({ durationMs: 4_503_000 });
		expect(screen.getByText("1:15:03")).toBeTruthy();
	});

	it("shows an unavailable state without a source", () => {
		setup({ httpUrl: null });
		expect(screen.getByText("Voice message unavailable")).toBeTruthy();
		expect(screen.queryByLabelText("Play voice message")).toBeNull();
	});

	it("fails visibly (without a misleading Retry) when Web Audio is unavailable", async () => {
		// jsdom has no AudioContext; the play press must fail closed
		// rather than throwing, and a retry can never succeed.
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		setup();
		fireEvent.click(screen.getByLabelText("Play voice message"));
		expect(fetchSpy).not.toHaveBeenCalled();
		await waitFor(() => {
			expect(screen.getByRole("alert")).toBeTruthy();
		});
		expect(screen.queryByText("Retry")).toBeNull();
	});

	it("fails closed (with Retry) when AudioContext construction throws", async () => {
		// Restricted environments / the browser's context limit can make
		// `new AudioContext()` throw; that must surface as the normal error
		// UI, not an uncaught exception - and it may be transient, so Retry
		// stays available (unlike Web Audio being absent entirely).
		vi.stubGlobal(
			"AudioContext",
			class {
				constructor() {
					throw new Error("context limit");
				}
			},
		);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		setup();
		fireEvent.click(screen.getByLabelText("Play voice message"));
		expect(fetchSpy).not.toHaveBeenCalled();
		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toContain(
				"Couldn't play voice message",
			);
		});
		expect(screen.getByText("Retry")).toBeTruthy();
	});

	it("loads on play, fails visibly, and can be retried in place", async () => {
		stubAudioContext();
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("network"));
		setup();
		fireEvent.click(screen.getByLabelText("Play voice message"));
		expect(fetchSpy).toHaveBeenCalledOnce();
		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toContain(
				"Couldn't play voice message",
			);
		});
		// A transient failure must not be terminal: Retry re-attempts the
		// load without needing a row remount.
		fireEvent.click(screen.getByText("Retry"));
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("fails closed BEFORE any network I/O for a missing encrypted descriptor", () => {
		// parseEncryptedFile already rejected the descriptor; downloading
		// the (undecryptable) ciphertext would be wasted, unbounded I/O.
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		setup({ isEncrypted: true, file: null });
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("Couldn't decrypt voice message");
		// No play button, no Retry (nothing can succeed), no fetch.
		expect(screen.queryByLabelText("Play voice message")).toBeNull();
		expect(screen.queryByText("Retry")).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("cancels (and aborts) an in-flight load when play is pressed again", async () => {
		stubAudioContext();
		// A fetch that never resolves keeps the load in flight; capture its
		// abort signal to assert the download is genuinely torn down.
		let signal: AbortSignal | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			(_url, init) =>
				new Promise(() => {
					signal = init?.signal ?? undefined;
				}) as Promise<Response>,
		);
		setup();
		const button = screen.getByLabelText("Play voice message");
		fireEvent.click(button);
		expect(screen.getByText("Loading…")).toBeTruthy();
		expect(signal?.aborted).toBe(false);
		// Second click reads as cancel: back to idle, the (eventual)
		// completion must not auto-start playback, and the download aborts.
		fireEvent.click(button);
		expect(screen.queryByText("Loading…")).toBeNull();
		expect(screen.getByText("1:23")).toBeTruthy();
		expect(signal?.aborted).toBe(true);
	});

	it("prefers the decoded duration over the wire-claimed one once loaded", async () => {
		stubAudioContext();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(new ArrayBuffer(16), { status: 200 }),
		);
		// Wire claims 83s but the real clip decodes to 2s; the decoded value
		// is ground truth (an understated wire duration would freeze the
		// progress UI while audio keeps playing).
		setup({ durationMs: 83_000 });
		expect(screen.getByText("1:23")).toBeTruthy();
		fireEvent.click(screen.getByLabelText("Play voice message"));
		await waitFor(() => {
			expect(screen.getByText(/\/ 0:02$/)).toBeTruthy();
		});
	});

	it("falls back to the decoded duration when the wire omits one", async () => {
		stubAudioContext();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(new ArrayBuffer(16), { status: 200 }),
		);
		setup({ durationMs: null });
		expect(screen.getByText("-:--")).toBeTruthy();
		fireEvent.click(screen.getByLabelText("Play voice message"));
		// The stubbed decode reports a 2s buffer; the total must react.
		await waitFor(() => {
			expect(screen.getByText(/0:02/)).toBeTruthy();
		});
	});
});

/** Minimal AudioContext stand-in for jsdom (which has none). */
function stubAudioContext(): void {
	class FakeAudioContext {
		currentTime = 0;
		destination = {};
		decodeAudioData(_buf: ArrayBuffer): Promise<{ duration: number }> {
			return Promise.resolve({ duration: 2 });
		}
		createBufferSource() {
			return {
				buffer: null as unknown,
				onended: null as (() => void) | null,
				connect: () => ({}),
				start: () => {},
				stop: () => {},
			};
		}
		close(): Promise<void> {
			return Promise.resolve();
		}
	}
	vi.stubGlobal("AudioContext", FakeAudioContext);
}
