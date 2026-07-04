import { type Component, Index } from "solid-js";

/** mm:ss readout for the recording bar timer. */
function formatRecordingTime(elapsedMs: number): string {
	const s = Math.max(0, Math.floor(elapsedMs / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface VoiceRecordingBarProps {
	/** Elapsed recording time in milliseconds (reactive). */
	elapsedMs: number;
	/** Live amplitude samples for the waveform (reactive). */
	amplitudes: number[];
	/** Cancel and discard the recording (Escape or the cancel button). */
	onCancel: () => void;
	/** Stop and send the recording. */
	onSend: () => void;
	/** Ref callback for the send button, so the composer can move focus into
	 *  the bar when recording starts. */
	sendButtonRef?: (el: HTMLButtonElement) => void;
}

/**
 * Voice recording bar: overlays the composer input area while capturing an
 * MSC3245 voice note. Purely presentational - the composer owns the recorder
 * and the send/cancel logic. Mounted only while recording (the parent gates it
 * behind the recorder's `recording()` state).
 */
const VoiceRecordingBar: Component<VoiceRecordingBarProps> = (props) => {
	return (
		<fieldset
			aria-label="Voice recording"
			class="absolute inset-0 z-10 flex min-w-0 items-center gap-2 rounded-lg bg-surface-2 px-3"
			onKeyDown={(e) => {
				// The composer textarea (which owns the usual Escape handling) is
				// inert under the bar; Esc cancels here.
				if (e.key === "Escape") {
					e.stopPropagation();
					props.onCancel();
				}
			}}
		>
			<span
				class="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-danger motion-reduce:animate-none"
				aria-hidden="true"
			/>
			<span
				role="timer"
				class="shrink-0 text-sm tabular-nums text-text-secondary"
			>
				{formatRecordingTime(props.elapsedMs)}
			</span>
			<div
				class="flex h-6 min-w-0 flex-1 items-center justify-end gap-px"
				aria-hidden="true"
			>
				<Index each={props.amplitudes}>
					{(amp) => (
						<span
							class="w-1 shrink-0 rounded-full bg-accent"
							style={{
								height: `${Math.round(Math.max(amp(), 0.12) * 100)}%`,
							}}
						/>
					)}
				</Index>
			</div>
			<button
				type="button"
				class="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-surface-3 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
				onClick={() => props.onCancel()}
				aria-label="Cancel recording"
			>
				<svg
					class="h-5 w-5"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					aria-hidden="true"
				>
					<path d="M18 6 6 18" />
					<path d="m6 6 12 12" />
				</svg>
			</button>
			<button
				ref={props.sendButtonRef}
				type="button"
				class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
				onClick={() => props.onSend()}
				aria-label="Send voice message"
			>
				<svg
					class="h-4 w-4"
					viewBox="0 0 24 24"
					fill="currentColor"
					aria-hidden="true"
				>
					<path d="m3 11 18-8-8 18-2-8-8-2z" />
				</svg>
			</button>
		</fieldset>
	);
};

export { VoiceRecordingBar };
