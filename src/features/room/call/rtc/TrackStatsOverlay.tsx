import type { LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import { type Component, Show } from "solid-js";
import { userSettings } from "../../../../stores/settings";
import {
	formatAnomalyLine,
	formatFrameLine,
	formatLimitationLine,
	formatRateLine,
	type StatsDirection,
} from "./trackStats";
import { type StatsSnapshot, useTrackStats } from "./useTrackStats";

/**
 * Single definition of the stats gate: the setting is on AND the tile's
 * participant is RESOLVED. `undefined` (participant record not found)
 * fails closed - during teardown the participant snapshot can empty
 * before the track maps do, and an unresolved tile must never render a
 * badge whose direction can't be known. A resolved tile shows receive
 * stats (remote, #408) or send stats (local, #409).
 *
 * Enforced INSIDE {@link TrackStatsOverlay} so no mount site - current or
 * future - can forget it; tiles just render the overlay unconditionally
 * and pass whatever isLocal they can resolve.
 */
function showTrackStats(isLocal: boolean | undefined): boolean {
	return userSettings().rtcShowCallStats && isLocal !== undefined;
}

interface TrackStatsOverlayProps {
	/**
	 * Track backing the tile: a remote track's inbound-rtp is read for
	 * the receive readout, a local track's outbound-rtp for the send one.
	 */
	track: LocalVideoTrack | RemoteVideoTrack;
	/**
	 * Whether the tile's participant is the local user (send-side badge),
	 * remote (receive-side badge), or undefined when the participant
	 * record couldn't be resolved - which fails closed (see
	 * {@link showTrackStats}).
	 */
	isLocal: boolean | undefined;
}

/**
 * Corner badge showing what a call tile is actually receiving (remote
 * tiles: decoded resolution/fps, receive bitrate, codec + hw/sw decode,
 * #408) or sending (local tiles: encoded resolution/fps, total upload
 * bitrate across simulcast layers, codec + hw/sw encode, and the
 * encoder's live qualityLimitationReason, #409) - so a screen-share
 * quality preset is verifiable end-to-end without server-side wire
 * inspection. Tiles render this component unconditionally; the badge
 * inside mounts (and polls) only while the `rtcShowCallStats` setting is
 * on, so the default-off state costs nothing.
 *
 * Purely presentational: all measurement, honesty invariants, and
 * lifecycle live in {@link useTrackStats} (whose per-track state survives
 * tile remounts). Rendering follows the tiles' over-video chrome idiom
 * (black scrim + white text, matching the name bar). A healthy stream is
 * two quiet lines; a third warning-tinted line means "a problem right
 * now" - receive side only while the drop/freeze counters are ACTIVELY
 * increasing, send side while the encoder self-reports a cpu/bandwidth
 * limitation. Non-interactive by design: `pointer-events-none`, no live
 * region (a per-second readout would spam screen readers).
 */
export const TrackStatsOverlay: Component<TrackStatsOverlayProps> = (props) => {
	const gateDirection = (): StatsDirection | null =>
		showTrackStats(props.isLocal) ? (props.isLocal ? "send" : "receive") : null;
	return (
		// The gate wraps the badge component (not just its output) so the
		// polling hook doesn't run at all while gated off. KEYED on the
		// direction: the badge latches its direction at mount, so a tile
		// whose isLocal resolution ever CHANGES without passing through
		// undefined must remount the badge rather than leave the poller on
		// the stale direction.
		<Show keyed when={gateDirection()}>
			{(direction) => (
				<TrackStatsBadge track={props.track} direction={direction} />
			)}
		</Show>
	);
};

// The warning line is direction-specific: the encoder's limitation
// self-report is live (send), the counter-delta signal is derived
// (receive). They're mutually exclusive by construction - the snapshot
// carries nulls/zeros for the other direction's fields.
function warningLine(s: StatsSnapshot): string | null {
	return (
		formatLimitationLine(
			s.qualityLimitationReason,
			s.qualityLimitationSeconds,
		) ??
		(s.anomaliesActive
			? formatAnomalyLine(s.framesDropped, s.freezeCount)
			: null)
	);
}

interface TrackStatsBadgeProps {
	track: LocalVideoTrack | RemoteVideoTrack;
	direction: StatsDirection;
}

const TrackStatsBadge: Component<TrackStatsBadgeProps> = (props) => {
	const snapshot = useTrackStats(() => props.track, props.direction);

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
							props.direction,
						)}
					</div>
					<Show when={formatRateLine(s().bitrate, s().codec, s().accel)}>
						{(line) => <div>{line()}</div>}
					</Show>
					<Show when={warningLine(s())}>
						{(warning) => <div class="text-warning-text">{warning()}</div>}
					</Show>
				</div>
			)}
		</Show>
	);
};
