import { type Component, Show } from "solid-js";
import type { PresenceStatus } from "../lib/presence";

interface PresenceDotProps {
	status: PresenceStatus;
	/**
	 * Tailwind ring colour for the cut-out, matching the surface the avatar
	 * sits on. Defaults to the sidebar/list surface; a card on `surface-2`
	 * passes its own, or the dot gets a near-black halo that reads as part of
	 * the picture - the opposite of what the ring is for.
	 */
	ringClass?: string | undefined;
	/**
	 * Box size of the avatar this sits on. The dot scales with it so the
	 * 64px profile portrait does not get a dot sized for a 32px list row.
	 */
	size?: "md" | "xl";
}

/**
 * Colour per state. Bright ramp values rather than the base ones: these are
 * ~10px circles on a dark surface, and `--color-success` at #15803d reads as
 * a dark smudge at that size where `--color-success-text` reads as green.
 */
const STATUS_CLASS: Record<Exclude<PresenceStatus, "unknown">, string> = {
	online: "bg-success-text",
	idle: "bg-warning-text",
	offline: "bg-indicator",
};

const STATUS_LABEL: Record<Exclude<PresenceStatus, "unknown">, string> = {
	online: "Online",
	idle: "Idle",
	offline: "Offline",
};

const SIZE_CLASS = {
	md: "h-2.5 w-2.5",
	xl: "h-4 w-4",
} as const;

/**
 * Presence indicator, positioned over the bottom-right of an avatar.
 *
 * Renders nothing for `unknown`. That state means the server has never told
 * us about this user, and a grey dot would assert they are offline - which is
 * a different and possibly wrong claim.
 *
 * The ring is drawn in the surface colour so the dot reads as sitting on top
 * of the avatar rather than being part of the picture, the same cut-out
 * Discord and Element use.
 */
const PresenceDot: Component<PresenceDotProps> = (props) => (
	// The callback form, so `status` is narrowed rather than cast. With a cast
	// a fifth PresenceStatus would compile clean here and render
	// `aria-label="undefined"`; this way it is a type error at the map.
	<Show when={props.status !== "unknown" ? props.status : null} keyed>
		{(status: Exclude<PresenceStatus, "unknown">) => (
			<span
				role="img"
				aria-label={STATUS_LABEL[status]}
				class={`absolute right-0 bottom-0 rounded-full ring-2 ${
					props.ringClass ?? "ring-surface-1"
				} ${SIZE_CLASS[props.size ?? "md"]} ${STATUS_CLASS[status]}`}
			/>
		)}
	</Show>
);

export { PresenceDot };
