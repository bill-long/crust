import { type Component, Show } from "solid-js";
import {
	createImageFallback,
	type FailedImageUrls,
} from "../lib/imageFallback";
import type { PresenceStatus } from "../lib/presence";
import { PresenceDot } from "./PresenceDot";

interface AvatarProps {
	url: string | null;
	initial: string;
	alt?: string;
	/**
	 * Presence indicator to overlay (#445). Omit where presence has no
	 * meaning - a room avatar, a space tile - rather than passing "unknown",
	 * so the extra wrapper element is not paid for at all.
	 */
	presence?: PresenceStatus;
	/** Ring colour for the presence cut-out; see PresenceDot. */
	presenceRingClass?: string;
	/**
	 * Box size: "md" is the 32px list/header avatar (default), "xl" the
	 * 64px profile-card portrait. Both share the fail-closed behavior.
	 */
	size?: "md" | "xl";
	/**
	 * Image loading strategy. Omitted by default (eager), matching the browser
	 * default for above-the-fold avatars like UserBar. Lists pass "lazy".
	 */
	loading?: "lazy" | "eager";
	/**
	 * Shared fail-closed registry from the component that owns the list this
	 * avatar renders in. Pass one wherever rows can remount (list builders that
	 * re-mint their entries), so a broken URL isn't re-attempted per remount.
	 * Omit for a standalone avatar - it then keeps private state.
	 */
	broken?: FailedImageUrls;
}

const SIZE_CLASS = {
	md: "h-8 w-8 text-xs",
	xl: "h-16 w-16 text-xl",
} as const;

/** Compact circular avatar with automatic image-error fallback. */
const Avatar: Component<AvatarProps> = (props) => {
	const avatar = createImageFallback(() => props.url, props.broken);
	const sizeClass = () => SIZE_CLASS[props.size ?? "md"];
	const fallbackClass = () =>
		`flex ${sizeClass()} shrink-0 items-center justify-center rounded-full bg-surface-3 font-semibold text-text-secondary`;

	// A function, not a value: as a bare identifier the compiler emits the
	// same nodes into both <Show> branches, so a call site that ever toggled
	// `presence` between undefined and set would move the avatar out from
	// under the branch still holding it.
	//
	// Calling it in both places below is not double work. A call expression in
	// a component prop compiles to a getter, so <Show> evaluates `fallback`
	// only on the branch that uses it. Avatar.test.tsx pins the result.
	const inner = () => (
		<Show
			when={!avatar.failed() && props.url}
			fallback={
				// Mirror the image branch's semantics: with an `alt`, the
				// fallback keeps announcing the same name; without one it is
				// decorative (adjacent text carries the name) and the bare
				// letter would only be noise read out before the real name.
				props.alt ? (
					<div role="img" aria-label={props.alt} class={fallbackClass()}>
						{props.initial}
					</div>
				) : (
					<div aria-hidden="true" class={fallbackClass()}>
						{props.initial}
					</div>
				)
			}
		>
			{(url) => (
				<img
					ref={avatar.ref}
					src={url()}
					alt={props.alt ?? ""}
					// bg paints the circle while the image is still in flight, so
					// a lazy avatar never leaves a transparent gap in the layout.
					class={`${sizeClass()} shrink-0 rounded-full bg-surface-3 object-cover`}
					loading={props.loading}
					onError={avatar.onError}
					onLoad={avatar.onLoad}
				/>
			)}
		</Show>
	);

	// Only wrap when there is a dot to position. Every existing call site
	// renders a bare avatar element today, and introducing a wrapper for all
	// of them would change flex/grid behaviour across the app for no reason.
	return (
		<Show when={props.presence !== undefined} fallback={inner()}>
			<span class={`relative inline-flex shrink-0 ${sizeClass()}`}>
				{inner()}
				<PresenceDot
					status={props.presence ?? "unknown"}
					size={props.size ?? "md"}
					ringClass={props.presenceRingClass}
				/>
			</span>
		</Show>
	);
};

export { Avatar };
