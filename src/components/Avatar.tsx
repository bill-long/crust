import { type Component, createEffect, createSignal, on, Show } from "solid-js";

interface AvatarProps {
	url: string | null;
	initial: string;
	alt?: string;
}

/** Compact 32px avatar with automatic image-error fallback. */
const Avatar: Component<AvatarProps> = (props) => {
	const [imgFailed, setImgFailed] = createSignal(false);
	createEffect(
		on(
			() => props.url,
			() => setImgFailed(false),
		),
	);

	return (
		<Show
			when={!imgFailed() && props.url}
			fallback={
				<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-text-secondary">
					{props.initial}
				</div>
			}
		>
			{(url) => (
				<img
					src={url()}
					alt={props.alt ?? ""}
					class="h-8 w-8 shrink-0 rounded-full object-cover"
					onError={() => setImgFailed(true)}
				/>
			)}
		</Show>
	);
};

export { Avatar };
