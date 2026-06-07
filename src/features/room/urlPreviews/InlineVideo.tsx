import { type Component, createEffect, createSignal, on, Show } from "solid-js";

/**
 * Click-to-load inline video player for direct-media URLs (e.g. a raw
 * `.mp4` link that has no OpenGraph preview).
 *
 * The third-party origin is never contacted until the user clicks play:
 * a lightweight poster button is shown first, and only on click is the
 * `<video>` element created. This keeps passive IP/bandwidth exposure
 * opt-in even though the repo's stated stance is that privacy is not a
 * priority. The player uses `preload="none"` and `referrerpolicy=
 * "no-referrer"` to further limit what leaks once the user does opt in.
 *
 * A reserved 16:9 box keeps the poster and the loaded video the same
 * size so there's no layout shift when the player appears.
 */
const InlineVideo: Component<{ url: string }> = (props) => {
	const [activated, setActivated] = createSignal(false);
	const [loadError, setLoadError] = createSignal(false);

	// Reset transient state when the URL changes (e.g. a message edit
	// rewrites the link while this component instance is reused).
	createEffect(
		on(
			() => props.url,
			() => {
				setActivated(false);
				setLoadError(false);
			},
			{ defer: true },
		),
	);

	return (
		<Show
			when={activated()}
			fallback={
				<button
					type="button"
					class="group relative mt-1 flex aspect-video w-full max-w-md items-center justify-center overflow-hidden rounded bg-surface-2 transition-colors hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
					onClick={() => setActivated(true)}
					aria-label="Load video"
				>
					<span class="flex h-12 w-12 items-center justify-center rounded-full bg-surface-0/70 text-text-primary transition-colors group-hover:bg-surface-0/90">
						<svg
							class="h-6 w-6"
							viewBox="0 0 24 24"
							fill="currentColor"
							aria-hidden="true"
						>
							<path d="M8 5v14l11-7z" />
						</svg>
					</span>
					<span class="absolute bottom-1 right-2 text-xs text-text-muted">
						Click to load video
					</span>
				</button>
			}
		>
			<Show
				when={!loadError()}
				fallback={
					<div class="mt-1 flex items-center gap-2 rounded bg-surface-2 px-3 py-2 text-sm text-text-muted">
						<span>Failed to load video</span>
						<a
							href={props.url}
							target="_blank"
							rel="noopener noreferrer"
							referrerPolicy="no-referrer"
							class="text-accent-text underline hover:text-accent-text-bright"
						>
							Open link
						</a>
					</div>
				}
			>
				{/* biome-ignore lint/a11y/useMediaCaption: remote third-party
				    media has no caption track available. */}
				<video
					controls
					autoplay
					playsinline
					preload="none"
					ref={(el) => {
						el.setAttribute("referrerpolicy", "no-referrer");
						// Assign `src` last so the first media request is issued
						// only after `referrerpolicy` is in place. `referrerpolicy`
						// is set via ref because it's absent from Solid's typed
						// VideoHTMLAttributes (unlike `playsinline`, set above).
						// The component unmounts the <video> when `props.url`
						// changes (the reset effect clears `activated`), so a
						// one-time read is safe.
						el.src = props.url;
					}}
					class="mt-1 block aspect-video w-full max-w-md rounded bg-surface-0 object-contain"
					onError={() => setLoadError(true)}
				/>
			</Show>
		</Show>
	);
};

export { InlineVideo };
