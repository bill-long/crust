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
import { getVoicePlaybackContext } from "./voicePlaybackContext";

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
 * player since a voice note's waveform and duration ARE its content. No
 * filename/download affordance, matching how voice notes present in
 * Element (they are utterances, not file attachments; the generic
 * MediaAudio path still serves plain audio files).
 *
 * Playback uses Web Audio (full fetch -> decodeAudioData ->
 * AudioBufferSourceNode) rather than an HTMLMediaElement, the same
 * architecture Element uses for voice notes: voice clips are small, the
 * homeserver's media responses may lack Content-Length / range support
 * (which stalls media-element streaming), and the encrypted path already
 * requires whole-blob decryption anyway.
 *
 * Safety/robustness contracts:
 * - Nothing is fetched until the first play press, and an encrypted
 *   message with a missing/malformed descriptor fails closed BEFORE any
 *   network I/O (mirrors MediaAudio's parseEncryptedFile contract).
 * - The async load snapshots every prop it uses at call start and
 *   re-checks its generation after each await, so a mid-flight source
 *   swap or unmount can neither feed ciphertext to the decoder nor start
 *   ghost playback (unmount bumps the generation).
 * - Load failures are retryable in place.
 * - Fixed-height row; the waveform bars flex-shrink so the time text can
 *   never overflow the fixed-width bubble.
 */
export const VoiceMessage: Component<VoiceMessageProps> = (props) => {
	const [loadState, setLoadState] = createSignal<LoadState>("idle");
	const [playing, setPlaying] = createSignal(false);
	const [elapsed, setElapsed] = createSignal(0);
	/** Web Audio is missing entirely - a failure Retry can never succeed. */
	const [unsupported, setUnsupported] = createSignal(false);
	/** Duration of the decoded buffer - a signal, so the total-time memo
	 *  reacts when the decode completes. */
	const [decodedDuration, setDecodedDuration] = createSignal<number | null>(
		null,
	);

	/** SHARED playback context (see voicePlaybackContext) - held per
	 *  component only as a reference; never closed here. */
	let audioContext: AudioContext | null = null;
	let audioBuffer: AudioBuffer | null = null;
	let sourceNode: AudioBufferSourceNode | null = null;
	/** Playback offset (seconds into the clip) when paused. */
	let pausedAt = 0;
	/** AudioContext time at which the current playback started, minus the
	 *  clip offset - so elapsed = ctx.currentTime - startedAt. */
	let startedAt = 0;
	let ticker: ReturnType<typeof setInterval> | null = null;
	/** Guards every await in loadBuffer: bumped on source-identity change
	 *  AND on unmount, so a stale load can never touch fresh state. */
	let loadGeneration = 0;
	/** Aborts the in-flight download when the load is cancelled, so a
	 *  "cancel" during loading stops consuming bandwidth too. */
	let abortController: AbortController | null = null;

	function invalidateLoad(): void {
		loadGeneration++;
		abortController?.abort();
		abortController = null;
	}

	/** Encrypted content without a valid descriptor must fail closed
	 *  before any network I/O (parseEncryptedFile already rejected it). */
	const undecryptable = createMemo(
		() => props.isEncrypted && props.file === null,
	);
	const failed = createMemo(() => undecryptable() || loadState() === "failed");

	const bars = createMemo(() => resampleWaveform(props.waveform));
	const durationSeconds = createMemo(() => {
		// The decoded buffer is ground truth; the wire duration is untrusted
		// sender data and only bridges the gap before the first load (a wire
		// value that understates the clip would otherwise freeze the
		// progress/readout while audio keeps playing).
		const decoded = decodedDuration();
		if (decoded !== null) return decoded;
		return props.durationMs !== null ? props.durationMs / 1000 : null;
	});
	const progress = createMemo(() => {
		const total = durationSeconds();
		if (!total || total <= 0) return 0;
		return Math.min(elapsed() / total, 1);
	});
	const timeLine = createMemo(() => {
		const total = durationSeconds();
		const totalText = total ? formatSeconds(total) : "-:--";
		if (!playing() && elapsed() === 0) return totalText;
		// The wire duration is untrusted and may understate the real clip
		// length; clamp the shown elapsed so it never ticks past the total.
		const shown = total ? Math.min(elapsed(), total) : elapsed();
		return `${formatSeconds(shown)} / ${totalText}`;
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
		invalidateLoad();
		stopPlayback(false);
		audioBuffer = null;
		pausedAt = 0;
		setElapsed(0);
		setDecodedDuration(null);
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
		// Invalidate (and abort) any in-flight load: without this, a
		// pending fetch/decode would recreate the AudioContext below and
		// start audible ghost playback with no player on screen.
		invalidateLoad();
		stopPlayback(false);
		// The context is shared across voice messages; drop only our
		// reference (never close it).
		audioContext = null;
	});

	async function loadBuffer(): Promise<void> {
		const gen = ++loadGeneration;
		// Snapshot EVERY prop this load depends on before the first await:
		// a recycled row can swap sources mid-flight, and pairing old bytes
		// with new crypto semantics could feed ciphertext to the decoder.
		const url = props.httpUrl;
		const encrypted = props.isEncrypted;
		const file = props.file;
		if (!url || (encrypted && !file)) {
			setLoadState("failed");
			return;
		}
		setLoadState("loading");
		abortController = new AbortController();
		try {
			const response = await fetch(url, { signal: abortController.signal });
			if (gen !== loadGeneration) return;
			if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
			let bytes = await response.arrayBuffer();
			if (gen !== loadGeneration) return;
			if (encrypted && file) {
				bytes = await decryptAttachment(bytes, file);
				if (gen !== loadGeneration) return;
			}
			if (!audioContext) throw new Error("no AudioContext");
			const decoded = await audioContext.decodeAudioData(bytes);
			if (gen !== loadGeneration) return;
			audioBuffer = decoded;
			setDecodedDuration(
				Number.isFinite(decoded.duration) && decoded.duration > 0
					? decoded.duration
					: null,
			);
			setLoadState("ready");
			startFrom(0);
		} catch {
			if (gen !== loadGeneration) return;
			setLoadState("failed");
		}
	}

	function startFrom(offsetSeconds: number): void {
		if (!audioContext || !audioBuffer) return;
		// Strict-autoplay browsers can leave a context suspended; resuming
		// is cheap and idempotent.
		if (audioContext.state === "suspended") {
			void audioContext.resume().catch(() => {});
		}
		// A pause landing at the clip's very end can leave pausedAt at (or
		// past) the buffer duration, which start(0, offset) may reject.
		const offset = Math.min(
			Math.max(offsetSeconds, 0),
			Math.max(0, audioBuffer.duration - 0.01),
		);
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
		source.start(0, offset);
		sourceNode = source;
		startedAt = audioContext.currentTime - offset;
		setPlaying(true);
		stopTicker();
		ticker = setInterval(() => {
			if (audioContext) {
				setElapsed(Math.max(0, audioContext.currentTime - startedAt));
			}
		}, TICK_MS);
	}

	const togglePlay = (): void => {
		if (undecryptable()) return;
		if (playing()) {
			stopPlayback(true);
			return;
		}
		// A click while loading reads as "cancel": invalidate (and abort)
		// the in-flight load so its completion can't auto-start playback
		// and the download stops consuming bandwidth.
		if (loadState() === "loading") {
			invalidateLoad();
			setLoadState("idle");
			return;
		}
		// Acquire the SHARED playback context inside the user-gesture call
		// stack (Safari autoplay policy); the async load reuses it.
		audioContext = getVoicePlaybackContext();
		if (!audioContext) {
			// Web Audio missing entirely is terminal (no Retry); a failed
			// context construction may be transient (context limit,
			// restricted environment) - keep Retry available.
			if (typeof AudioContext === "undefined") setUnsupported(true);
			setLoadState("failed");
			return;
		}
		if (loadState() === "ready" && audioBuffer) {
			startFrom(pausedAt);
			return;
		}
		void loadBuffer();
	};

	const retry = (): void => {
		setLoadState("idle");
		togglePlay();
	};

	return (
		<div class="flex h-12 w-full max-w-72 items-center gap-2 rounded-lg border border-border-subtle bg-surface-2 px-3">
			<Show
				when={props.httpUrl}
				fallback={
					<span class="text-sm text-text-muted">Voice message unavailable</span>
				}
			>
				<Show
					when={!failed()}
					fallback={
						<>
							<span
								class="min-w-0 flex-1 truncate text-sm text-danger-text"
								role="alert"
							>
								{props.isEncrypted
									? "Couldn't decrypt voice message"
									: "Couldn't play voice message"}
							</span>
							{/* No Retry for non-recoverable failures: a missing
							    descriptor or missing Web Audio cannot succeed. */}
							<Show when={!undecryptable() && !unsupported()}>
								<button
									type="button"
									class="shrink-0 rounded px-1 text-xs font-medium text-text-secondary underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									onClick={retry}
								>
									Retry
								</button>
							</Show>
						</>
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
					{/* Bars flex-shrink (min-w-0, no fixed width) so the time text
					    always fits inside the fixed-width bubble. */}
					<div
						class="flex h-8 min-w-0 flex-1 items-center gap-px"
						aria-hidden="true"
					>
						<For each={bars()}>
							{(bar, index) => (
								<span
									class={`min-w-0 max-w-1 flex-1 rounded-full transition-colors ${
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
