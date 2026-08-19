import { type Component, Show } from "solid-js";
import {
	createImageFallback,
	type FailedImageUrls,
} from "../lib/imageFallback";

interface RowAvatarProps {
	url: string | null;
	/** Letter shown when there is no avatar, or the avatar fails to load. */
	initial: string;
	/** Circle for people, rounded square for rooms and spaces. */
	shape?: "circle" | "square";
	/**
	 * Fail-closed registry owned by the component that renders the list. Pass
	 * one wherever rows can remount - the list builders in this app re-mint
	 * their entries freely - so a broken URL is not re-attempted per remount.
	 */
	broken?: FailedImageUrls;
}

/**
 * 32px list-row avatar: image with an initial-letter placeholder underneath.
 * Fail-closed - a URL that 404s or fails to decode falls back to the initial
 * instead of the browser's broken-image icon (#457).
 */
const RowAvatar: Component<RowAvatarProps> = (props) => {
	const avatar = createImageFallback(() => props.url, props.broken);
	const rounding = () =>
		props.shape === "square" ? "rounded-md" : "rounded-full";
	return (
		<div
			class={`flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden ${rounding()} bg-surface-2 text-xs font-semibold text-text-secondary`}
		>
			<Show
				when={!avatar.failed() && props.url}
				fallback={<span>{props.initial}</span>}
			>
				{(url) => (
					<img
						ref={avatar.ref}
						src={url()}
						alt=""
						class="h-full w-full object-cover"
						onError={avatar.onError}
						onLoad={avatar.onLoad}
					/>
				)}
			</Show>
		</div>
	);
};

export { RowAvatar };
