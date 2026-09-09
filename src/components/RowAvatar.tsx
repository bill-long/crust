import type { Component } from "solid-js";
import type { FailedImageUrls } from "../lib/imageFallback";
import { Avatar } from "./Avatar";

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
const RowAvatar: Component<RowAvatarProps> = (props) => (
	<Avatar
		url={props.url}
		initial={props.initial}
		broken={props.broken}
		appearanceClass={`${props.shape === "square" ? "rounded-md" : "rounded-full"} bg-surface-2 text-text-secondary`}
	/>
);

export { RowAvatar };
