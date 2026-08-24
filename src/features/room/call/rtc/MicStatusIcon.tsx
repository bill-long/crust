import { type Component, Match, Switch } from "solid-js";

/**
 * Path set for the crossed-out microphone glyph (feather mic-off, minus the
 * mic stand). Shared between {@link MicStatusIcon} and `FullCallOverlay`'s
 * mute toggle (which adds the stand lines) so a glyph tweak cannot leave one
 * surface a revision behind.
 */
export const MicOffGlyph: Component = () => (
	<>
		<line x1="1" y1="1" x2="23" y2="23" />
		<path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
		<path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
	</>
);

interface MicStatusIconProps {
	/** Effective muted state. Callers fold in any local override first (the
	 *  PiP panel derives the local row from the voice store, not LiveKit). */
	muted: boolean;
	/** True when the mic state is unknowable: the peer has no publication on
	 *  our SFU and is foreign/unresolved, so `muted` is an artifact (#488). */
	micUnavailable: boolean;
	/** Words the unavailable label: true names the cause ("different server"). */
	isForeignSfu: boolean;
	/** Extra classes for the muted-mic icon (surfaces differ: danger red in
	 *  the panel rows, inherited white on the tile's name bar). */
	mutedClass?: string;
}

/**
 * The per-participant mic indicator shared by the PiP panel, the `/overlay`
 * view, and the full-call tile. One definition on purpose: the
 * `micUnavailable`-before-`muted` precedence is the #488 invariant (a peer
 * publishing to a different SFU, or one we cannot map to a membership, has
 * no mic publication here, so "muted" would be a false claim), and a copy
 * per surface is how that gate gets lost.
 *
 * Label wording: the foreign branch names both media - a membership that
 * publishes to another SFU sends us no tracks at all, video included. The
 * generic (unresolved-peer) branch claims only audio: `micUnavailable`
 * derives from the absence of a mic publication, and an unresolved same-SFU
 * peer's video track can still be playing.
 *
 * Renders nothing when the mic is live. No event handlers, so it is safe in
 * the cross-window PiP document (`CallOverlayPanel`).
 */
export const MicStatusIcon: Component<MicStatusIconProps> = (props) => {
	const unavailableLabel = (): string =>
		props.isForeignSfu
			? "Connected via a different server - their audio and video are unavailable"
			: "Their audio is unavailable";
	return (
		<Switch>
			<Match when={props.micUnavailable}>
				<svg
					class="h-3.5 w-3.5 shrink-0 text-warning-text"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					role="img"
					aria-label={unavailableLabel()}
				>
					<title>{unavailableLabel()}</title>
					{/* Cloud-off: their media lives on a server we don't reach. */}
					<path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3" />
					<line x1="1" y1="1" x2="23" y2="23" />
				</svg>
			</Match>
			<Match when={props.muted}>
				<svg
					class={`h-3.5 w-3.5 shrink-0 ${props.mutedClass ?? ""}`}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					role="img"
					aria-label="Microphone muted"
				>
					<MicOffGlyph />
				</svg>
			</Match>
		</Switch>
	);
};
