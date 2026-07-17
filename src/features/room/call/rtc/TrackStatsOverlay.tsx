import type { LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import { type Component, Show } from "solid-js";
import { userSettings } from "../../../../stores/settings";
import {
	formatAnomalyLine,
	formatFrameLine,
	formatRateLine,
} from "./trackStats";
import { useTrackStats } from "./useTrackStats";

/**
 * Single definition of the receive-stats gate (#408): the setting is on
 * AND the tile belongs to a RESOLVED remote participant. `undefined`
 * (participant record not found) fails closed - during teardown the
 * participant snapshot can empty before the track maps do, and a missing
 * record must never put receive stats on a local tile. #409 relaxes this
 * for local tiles with a send-side (outbound-rtp) readout.
 *
 * Enforced INSIDE {@link TrackStatsOverlay} so no mount site - current or
 * future - can forget it; tiles just render the overlay unconditionally
 * and pass whatever isLocal they can resolve.
 */
function showReceiveStats(isLocal: boolean | undefined): boolean {
	return userSettings().rtcShowCallStats && isLocal === false;
}

interface TrackStatsOverlayProps {
	/**
	 * Track backing the tile. Remote-only in the receive-stats phase
	 * (#408); typed to admit local tracks for the send-stats follow-up
	 * (#409), which reads outbound-rtp instead.
	 */
	track: LocalVideoTrack | RemoteVideoTrack;
	/**
	 * Whether the tile's participant is the local user, or undefined when
	 * the participant record couldn't be resolved. Anything but an
	 * explicit `false` fails closed (see {@link showReceiveStats}).
	 */
	isLocal: boolean | undefined;
}

/**
 * Corner badge showing what a call tile is actually receiving - decoded
 * resolution/fps, receive bitrate, codec (plus hw/sw decode where the
 * browser exposes it) - so a screen-share quality preset is verifiable
 * end-to-end without server-side wire inspection (#408). Mounted by the
 * call tiles only while the `rtcShowCallStats` setting is on; the
 * default-off state costs nothing.
 *
 * Purely presentational: all measurement, honesty invariants, and
 * lifecycle live in {@link useTrackStats} (whose per-track state survives
 * tile remounts). Rendering follows the tiles' over-video chrome idiom
 * (black scrim + white text, matching the name bar). A healthy stream is
 * two quiet lines; a third warning-tinted line appears only while the
 * drop/freeze counters are ACTIVELY increasing, so the badge growing
 * means "a problem right now", not "a blip an hour ago". Non-interactive
 * by design: `pointer-events-none`, no live region (a per-second readout
 * would spam screen readers).
 */
export const TrackStatsOverlay: Component<TrackStatsOverlayProps> = (props) => (
	// The gate wraps the badge component (not just its output) so the
	// polling hook doesn't run at all while gated off.
	<Show when={showReceiveStats(props.isLocal)}>
		<TrackStatsBadge track={props.track} />
	</Show>
);

const TrackStatsBadge: Component<Pick<TrackStatsOverlayProps, "track">> = (
	props,
) => {
	const snapshot = useTrackStats(() => props.track);

	return (
		<Show when={snapshot()}>
			{(s) => (
				<div
					class="pointer-events-none absolute left-1 top-1 rounded bg-black/40 px-1.5 py-1 font-mono text-[10px] leading-tight text-white"
					data-testid="track-stats"
				>
					<div>
						{formatFrameLine(
							s().frameWidth,
							s().frameHeight,
							s().framesPerSecond,
						)}
					</div>
					<Show when={formatRateLine(s().bitrate, s().codec, s().decoder)}>
						{(line) => <div>{line()}</div>}
					</Show>
					<Show
						when={
							s().anomaliesActive
								? formatAnomalyLine(s().framesDropped, s().freezeCount)
								: null
						}
					>
						{(anomalies) => <div class="text-warning-text">{anomalies()}</div>}
					</Show>
				</div>
			)}
		</Show>
	);
};
