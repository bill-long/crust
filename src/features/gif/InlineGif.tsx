import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	on,
	Show,
} from "solid-js";
import { userSettings } from "../../stores/settings";

// Re-export pure URL utilities from gifUrl.ts so existing imports still work
export { extractGifUrl, isGifUrl } from "./gifUrl";

/**
 * Inline GIF renderer. Replaces the normal text body in the timeline
 * when a message contains a recognized GIF provider URL.
 */
const InlineGif: Component<{
	url: string;
	alt: string;
}> = (props) => {
	const autoDownload = createMemo(() => userSettings().autoDownloadGifs);
	const [manuallyLoaded, setManuallyLoaded] = createSignal(false);
	const [loadError, setLoadError] = createSignal(false);

	// Reset transient state when the URL changes (e.g. a message edit
	// rewrites the GIF URL while the component instance is reused).
	createEffect(
		on(
			() => props.url,
			() => {
				setManuallyLoaded(false);
				setLoadError(false);
			},
			{ defer: true },
		),
	);

	return (
		<Show
			when={autoDownload() || manuallyLoaded()}
			fallback={
				<button
					type="button"
					class="mt-1 flex items-center gap-2 rounded bg-surface-2 px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-3 hover:text-text-secondary"
					onClick={() => setManuallyLoaded(true)}
					aria-label={`Load GIF: ${props.alt}`}
				>
					<span class="text-lg">🖼️</span>
					<span>Click to load GIF</span>
				</button>
			}
		>
			<Show
				when={!loadError()}
				fallback={
					<div class="mt-1 flex items-center gap-2 rounded bg-surface-2 px-3 py-2 text-sm text-text-muted">
						<span>Failed to load GIF</span>
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
				<img
					src={props.url}
					alt={props.alt}
					class="mt-1 block max-h-64 max-w-sm rounded"
					loading="lazy"
					referrerPolicy="no-referrer"
					onError={() => setLoadError(true)}
				/>
			</Show>
		</Show>
	);
};

export { InlineGif };
