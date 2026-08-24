import { type Component, type JSX, Show } from "solid-js";

interface ParticipantNameLabelProps {
	/** The participant's fields the label renders. Structural subset so both
	 *  `RtcParticipant` and the bridge's `CallOverlayParticipant` (where the
	 *  additive #488 fields are optional) satisfy it. */
	participant: {
		displayName: string;
		identity: string;
		isLocal: boolean;
		isUnresolved?: boolean;
	};
	/** Classes for the outer name span (layout + typography per surface). */
	class: string;
	/** Classes for the "(you)" suffix span. */
	youClass: string;
	/** Extra cue spans appended inside the label (e.g. the sr-only
	 *  "(speaking)" announcement in the list surfaces). */
	children?: JSX.Element;
}

/**
 * Participant name span shared by the PiP panel, the `/overlay` view, and
 * the full-call tile. Carries the #488 unresolved-identity rule in one
 * place: never render the opaque LiveKit identity as the name, but keep the
 * full raw value reachable as a `title` tooltip for debugging.
 *
 * Static markup only - safe in the cross-window PiP document.
 */
export const ParticipantNameLabel: Component<ParticipantNameLabelProps> = (
	props,
) => (
	<span
		class={props.class}
		title={
			props.participant.isUnresolved ? props.participant.identity : undefined
		}
	>
		{props.participant.displayName}
		<Show when={props.participant.isLocal}>
			<span class={props.youClass}>(you)</span>
		</Show>
		{props.children}
	</span>
);
