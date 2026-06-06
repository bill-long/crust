import { type Component, Match, Switch } from "solid-js";
import type { StateNoticeIcon as StateNoticeIconKind } from "./stateNotice";

interface StateNoticeIconProps {
	variant: StateNoticeIconKind;
}

/**
 * Compact leading glyph for a timeline state notice, shown in the same gutter
 * column as message avatars: an arrow-in for arrivals, an arrow-out for
 * departures, and a neutral info circle for everything else. Decorative —
 * the notice text carries the meaning, so this is `aria-hidden`.
 */
const StateNoticeIcon: Component<StateNoticeIconProps> = (props) => (
	<svg
		class="h-3.5 w-3.5"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<Switch>
			<Match when={props.variant === "join"}>
				<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
				<polyline points="10 17 15 12 10 7" />
				<line x1="15" y1="12" x2="3" y2="12" />
			</Match>
			<Match when={props.variant === "leave"}>
				<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
				<polyline points="16 17 21 12 16 7" />
				<line x1="21" y1="12" x2="9" y2="12" />
			</Match>
			<Match when={props.variant === "info"}>
				<circle cx="12" cy="12" r="10" />
				<line x1="12" y1="16" x2="12" y2="12" />
				<line x1="12" y1="8" x2="12.01" y2="8" />
			</Match>
		</Switch>
	</svg>
);

export { StateNoticeIcon };
