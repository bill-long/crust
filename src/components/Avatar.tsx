import { type Component, Show } from "solid-js";
import {
	createImageFallback,
	type FailedImageUrls,
} from "../lib/imageFallback";

interface AvatarProps {
	url: string | null;
	initial: string;
	alt?: string;
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

/** Compact 32px avatar with automatic image-error fallback. */
const Avatar: Component<AvatarProps> = (props) => {
	const avatar = createImageFallback(() => props.url, props.broken);

	return (
		<Show
			when={!avatar.failed() && props.url}
			fallback={
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-text-secondary">
					{props.initial}
				</div>
			}
		>
			{(url) => (
				<img
					ref={avatar.ref}
					src={url()}
					alt={props.alt ?? ""}
					// bg paints the circle while the image is still in flight, so
					// a lazy avatar never leaves a transparent gap in the layout.
					class="h-8 w-8 shrink-0 rounded-full bg-surface-3 object-cover"
					loading={props.loading}
					onError={avatar.onError}
					onLoad={avatar.onLoad}
				/>
			)}
		</Show>
	);
};

export { Avatar };
