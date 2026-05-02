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
	onLoad?: () => void;
}> = (props) => {
	const autoDownload = createMemo(() => userSettings().autoDownloadGifs);
	const [manuallyLoaded, setManuallyLoaded] = createSignal(false);
	const [loadError, setLoadError] = createSignal(false);

	// Reset state when URL changes
	createEffect(
		on(
			() => props.url,
			() => {
				setManuallyLoaded(false);
				setLoadError(false);
			},
		),
	);

	return (
		<Show
			when={autoDownload() || manuallyLoaded()}
			fallback={
				<button
					type="button"
					class="mt-1 flex items-center gap-2 rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-neutral-300"
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
					<div class="mt-1 flex items-center gap-2 rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-400">
						<span>Failed to load GIF</span>
						<a
							href={props.url}
							target="_blank"
							rel="noopener noreferrer"
							class="text-pink-400 underline hover:text-pink-300"
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
					onLoad={() => props.onLoad?.()}
					onError={() => {
						setLoadError(true);
						props.onLoad?.();
					}}
				/>
			</Show>
		</Show>
	);
};

export default InlineGif;
