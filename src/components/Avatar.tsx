import { type Component, type JSX, Show } from "solid-js";
import {
	createImageFallback,
	type FailedImageUrls,
} from "../lib/imageFallback";
import type { PresenceStatus } from "../lib/presence";
import { PresenceDot } from "./PresenceDot";

interface AvatarProps {
	url: string | null;
	initial: JSX.Element;
	alt?: string;
	/**
	 * Presence indicator to overlay (#445). Omit where presence has no
	 * meaning - a room avatar, a space tile - rather than passing "unknown",
	 * so the extra wrapper element is not paid for at all.
	 */
	presence?: PresenceStatus;
	/** Ring colour for the presence cut-out; see PresenceDot. */
	presenceRingClass?: string;
	/** Fixed box sizes, or a container-relative portrait for call tiles. */
	size?: "xs" | "md" | "lg" | "xl" | "2xl" | "3xl" | "tile";
	/** Replaces the default rounding and colors; geometry stays size-controlled. */
	appearanceClass?: string;
	/** Decorations shared by the image and fallback, such as stacked-avatar rings. */
	class?: string;
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
	broken?: FailedImageUrls | undefined;
}

const SIZE_CLASS = {
	xs: "h-4 w-4 text-[8px]",
	md: "h-8 w-8 text-xs",
	lg: "h-10 w-10 text-sm",
	xl: "h-16 w-16 text-xl",
	"2xl": "h-20 w-20 text-2xl",
	"3xl": "h-24 w-24 text-2xl",
	tile: "aspect-square w-[clamp(3rem,45cqmin,14rem)] text-[clamp(1rem,18cqmin,4rem)]",
} as const;

/** Compact circular avatar with automatic image-error fallback. */
const Avatar: Component<AvatarProps> = (props) => {
	const avatar = createImageFallback(() => props.url, props.broken);
	const sizeClass = () => SIZE_CLASS[props.size ?? "md"];
	const sharedClass = () =>
		`${sizeClass()} shrink-0 ${props.appearanceClass ?? "rounded-full bg-surface-3 text-text-secondary"} ${props.class ?? ""}`;
	const fallbackClass = () =>
		`flex items-center justify-center font-semibold ${sharedClass()}`;

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
					class={`${sharedClass()} object-cover`}
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
					size={
						props.size === "md" ||
						props.size === "xs" ||
						props.size === "lg" ||
						!props.size
							? "md"
							: "xl"
					}
					ringClass={props.presenceRingClass}
				/>
			</span>
		</Show>
	);
};

export { Avatar };
