import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	Show,
} from "solid-js";
import {
	decryptAttachment,
	type EncryptedFileInfo,
} from "../composer/media/attachmentCrypto";

interface VoiceMessageProps {
	/** Audio source. For encrypted rooms this is CIPHERTEXT (decrypted via
	 *  `file` before playback, never played directly). */
	httpUrl: string | null;
	file: EncryptedFileInfo | null;
	mimetype: string | null;
	isEncrypted: boolean;
	/** MSC1767 duration in ms, or null (falls back to decoded duration). */
	durationMs: number | null;
	/** MSC3246 amplitude samples normalized to 0..1, or null. */
	waveform: number[] | null;
}

/** Bars rendered for the waveform; wire samples are resampled to this. */
const WAVEFORM_BARS = 40;
/** Minimum visible bar height fraction so silent stretches stay visible. */
const MIN_BAR = 0.12;
/** Elapsed-time UI tick while playing. */
const TICK_MS = 200;

/** Resample amplitude samples to a fixed bar count (bucket max, so short
 *  peaks stay visible). A null/empty input yields uniform mid-height bars,
 *  matching clients that omit the waveform. */
function resampleWaveform(samples: number[] | null): number[] {
	if (!samples || samples.length === 0) {
		return new Array(WAVEFORM_BARS).fill(0.35);
	}
	const bars: number[] = [];
	for (let i = 0; i < WAVEFORM_BARS; i++) {
		const start = Math.floor((i * samples.length) / WAVEFORM_BARS);
		const end = Math.max(
			start + 1,
			Math.floor(((i + 1) * samples.length) / WAVEFORM_BARS),
		);
		let max = 0;
		for (let j = start; j < end; j++) {
			if (samples[j] > max) max = samples[j];
		}
		bars.push(Math.max(max, MIN_BAR));
	}
	return bars;
}

function formatSeconds(totalSeconds: number): string {
	const s = Math.max(0, Math.round(totalSeconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type LoadState = "idle" | "loading" | "ready" | "failed";

/**
 * Renderer for an MSC3245 voice message: play/pause, waveform with played
 * progress, and elapsed/total time - distinct from the generic MediaAudio
 * player since a voice note's waveform and duration ARE its content.
 *
 * Playback uses Web Audio (full fetch -> decodeAudioData ->
 * AudioBufferSourceNode) rather than an HTMLMediaElement, the same
 * architecture Element uses for voice notes: voice clips are small, the
 * homeserver's media responses may lack Content-Length / range support
 * (which stalls media-element streaming), and the encrypted path already
 * requires whole-blob decryption anyway. Nothing is fetched until the
 * first play press, and the encrypted path decrypts via
 * `decryptAttachment` and fails closed ("Couldn't decrypt") rather than
 * ever feeding ciphertext to the decoder. Fixed-height row so the
 * virtualizer never reflows.
 */
export const VoiceMessage: Component<VoiceMessageProps> = (props) => {
	const [loadState, setLoadState] = createSignal<LoadState>("idle");
	const [playing, setPlaying] = createSignal(false);
	const [elapsed, setElapsed] = createSignal(0);

	let audioContext: AudioContext | null = null;
	let audioBuffer: AudioBuffer | null = null;
	let sourceNode: AudioBufferSourceNode | null = null;
	/** Playback offset (seconds into the clip) when paused. */
	let pausedAt = 0;
	/** AudioContext time at which the current playback started, minus the
	 *  clip offset - so elapsed = ctx.currentTime - startedAt. */
	let startedAt = 0;
	let ticker: ReturnType<typeof setInterval> | null = null;
	/** Guards stale async loads after the source identity changed. */
	let loadGeneration = 0;

	const bars = createMemo(() => resampleWaveform(props.waveform));
	const durationSeconds = createMemo(() => {
		if (props.durationMs !== null) return props.durationMs / 1000;
		return audioBuffer ? audioBuffer.duration : null;
	});
	const progress = createMemo(() => {
		const total = durationSeconds();
		if (!total || total <= 0) return 0;
		return Math.min(elapsed() / total, 1);
	});
	const timeLine = createMemo(() => {
		const total = durationSeconds();
		const totalText = total ? formatSeconds(total) : "-:--";
		return playing() || elapsed() > 0
			? `${formatSeconds(elapsed())} / ${totalText}`
			: totalText;
	});

	function stopTicker(): void {
		if (ticker !== null) {
			clearInterval(ticker);
			ticker = null;
		}
	}

	function stopPlayback(rememberOffset: boolean): void {
		if (sourceNode) {
			sourceNode.onended = null;
			try {
				sourceNode.stop();
			} catch {
				// Never started or already stopped.
			}
			sourceNode = null;
		}
		stopTicker();
		if (rememberOffset && audioContext) {
			pausedAt = Math.max(0, audioContext.currentTime - startedAt);
			setElapsed(pausedAt);
		}
		setPlaying(false);
	}

	function resetAll(): void {
		loadGeneration++;
		stopPlayback(false);
		audioBuffer = null;
		pausedAt = 0;
		setElapsed(0);
		setLoadState("idle");
	}

	// Reset on ANY source-identity change (url + full crypto descriptor),
	// mirroring the media components' full-identity reset rule.
	createEffect(
		on(
			() => [
				props.httpUrl,
				props.file?.url,
				props.file?.iv,
				props.file?.key.k,
				props.file?.hashes.sha256,
				props.mimetype,
			],
			resetAll,
			{ defer: true },
		),
	);

	onCleanup(() => {
		stopPlayback(false);
		void audioContext?.close().catch(() => {});
		audioContext = null;
	});

	async function loadBuffer(): Promise<void> {
		const gen = ++loadGeneration;
		setLoadState("loading");
		try {
			const url = props.httpUrl;
			if (!url) throw new Error("no source");
			const response = await fetch(url);
			if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
			let bytes = await response.arrayBuffer();
			if (props.isEncrypted) {
				const file = props.file;
				// Fail closed: without a valid descriptor the ciphertext must
				// never reach the decoder.
				if (!file) throw new Error("missing encryption descriptor");
				bytes = await decryptAttachment(bytes, file);
			}
			audioContext ??= new AudioContext();
			const decoded = await audioContext.decodeAudioData(bytes);
			if (gen !== loadGeneration) return;
			audioBuffer = decoded;
			setLoadState("ready");
			startFrom(0);
		} catch {
			if (gen !== loadGeneration) return;
			setLoadState("failed");
		}
	}

	function startFrom(offsetSeconds: number): void {
		if (!audioContext || !audioBuffer) return;
		const source = audioContext.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(audioContext.destination);
		source.onended = () => {
			// Natural end of clip (pause detaches onended first).
			stopTicker();
			sourceNode = null;
			pausedAt = 0;
			setElapsed(0);
			setPlaying(false);
		};
		source.start(0, offsetSeconds);
		sourceNode = source;
		startedAt = audioContext.currentTime - offsetSeconds;
		setPlaying(true);
		stopTicker();
		ticker = setInterval(() => {
			if (audioContext) {
				setElapsed(Math.max(0, audioContext.currentTime - startedAt));
			}
		}, TICK_MS);
	}

	const togglePlay = (): void => {
		if (typeof AudioContext === "undefined") {
			setLoadState("failed");
			return;
		}
		if (playing()) {
			stopPlayback(true);
			return;
		}
		if (loadState() === "ready" && audioBuffer) {
			startFrom(pausedAt);
			return;
		}
		if (loadState() !== "loading") {
			void loadBuffer();
		}
	};

	return (
		<div class="flex h-12 w-72 items-center gap-2 rounded-lg border border-border-subtle bg-surface-2 px-3">
			<Show
				when={props.httpUrl}
				fallback={
					<span class="text-sm text-text-muted">Voice message unavailable</span>
				}
			>
				<Show
					when={loadState() !== "failed"}
					fallback={
						<span class="text-sm text-danger-text" role="alert">
							{props.isEncrypted
								? "Couldn't decrypt voice message"
								: "Couldn't play voice message"}
						</span>
					}
				>
					<button
						type="button"
						class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:opacity-60"
						aria-label={
							playing() ? "Pause voice message" : "Play voice message"
						}
						aria-busy={loadState() === "loading"}
						onClick={togglePlay}
					>
						<Show
							when={playing()}
							fallback={
								<svg
									class="ml-0.5 h-4 w-4"
									viewBox="0 0 24 24"
									fill="currentColor"
									aria-hidden="true"
								>
									<path d="M8 5v14l11-7z" />
								</svg>
							}
						>
							<svg
								class="h-4 w-4"
								viewBox="0 0 24 24"
								fill="currentColor"
								aria-hidden="true"
							>
								<path d="M6 5h4v14H6zM14 5h4v14h-4z" />
							</svg>
						</Show>
					</button>
					<div class="flex h-8 flex-1 items-center gap-px" aria-hidden="true">
						<For each={bars()}>
							{(bar, index) => (
								<span
									class={`w-1 shrink-0 rounded-full transition-colors ${
										index() / WAVEFORM_BARS < progress()
											? "bg-accent"
											: "bg-surface-3"
									}`}
									style={{ height: `${Math.round(bar * 100)}%` }}
								/>
							)}
						</For>
					</div>
					<span class="shrink-0 text-xs tabular-nums text-text-muted">
						<Show when={loadState() !== "loading"} fallback="Loading…">
							{timeLine()}
						</Show>
					</span>
				</Show>
			</Show>
		</div>
	);
};
