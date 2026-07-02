import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceMessage } from "./VoiceMessage";

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

	it("shows an unavailable state without a source", () => {
		setup({ httpUrl: null });
		expect(screen.getByText("Voice message unavailable")).toBeTruthy();
		expect(screen.queryByLabelText("Play voice message")).toBeNull();
	});

	it("fails visibly when Web Audio is unavailable", async () => {
		// jsdom has no AudioContext; the play press must fail closed
		// rather than throwing.
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		setup();
		fireEvent.click(screen.getByLabelText("Play voice message"));
		expect(fetchSpy).not.toHaveBeenCalled();
		await waitFor(() => {
			expect(screen.getByRole("alert")).toBeTruthy();
		});
	});

	it("loads on play and fails visibly when the fetch fails", async () => {
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
	});

	it("fails closed for encrypted audio with a missing descriptor", async () => {
		stubAudioContext();
		// A valid-looking fetch response whose ciphertext has no descriptor
		// must never reach the decoder.
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(new ArrayBuffer(16), { status: 200 }),
		);
		setup({ isEncrypted: true, file: null });
		fireEvent.click(screen.getByLabelText("Play voice message"));
		await waitFor(() => {
			expect(screen.getByRole("alert").textContent).toContain(
				"Couldn't decrypt voice message",
			);
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
