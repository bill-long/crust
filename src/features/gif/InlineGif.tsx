import { type Component, createMemo, Show } from "solid-js";
import { userSettings } from "../../stores/settings";

/**
 * Known GIF provider CDN URL patterns.
 * Order matters — first match wins.
 */
const GIF_URL_PATTERNS: readonly RegExp[] = [
	// Giphy: media.giphy.com, media0-4.giphy.com
	/^https:\/\/media[0-4]?\.giphy\.com\//,
	// Klipy
	/^https:\/\/media\.klipy\.com\//,
	// Tenor (for receiving GIFs from other clients)
	/^https:\/\/(?:media|c)\.tenor\.com\//,
];

/** Check if a URL is a known GIF provider CDN URL. */
export function isGifUrl(url: string): boolean {
	return GIF_URL_PATTERNS.some((re) => re.test(url));
}

/**
 * Extract a GIF CDN URL from a plain-text message body.
 * Returns the URL if the message is primarily a GIF link
 * (possibly with a label prefix like "Giphy .gif: https://...").
 */
export function extractGifUrl(body: string): string | null {
	const trimmed = body.trim();

	// Direct URL only
	if (isGifUrl(trimmed)) return trimmed;

	// "Label: URL" pattern (how Crust sends GIFs)
	const match = trimmed.match(/^.{0,80}(https:\/\/\S+)$/);
	if (match) {
		const url = match[1];
		if (isGifUrl(url)) return url;
	}

	return null;
}

/**
 * Inline GIF renderer. Replaces the normal text body in the timeline
 * when a message contains a recognized GIF provider URL.
 */
const InlineGif: Component<{
	url: string;
	alt: string;
}> = (props) => {
	const autoDownload = createMemo(() => userSettings().autoDownloadGifs);

	return (
		<Show
			when={autoDownload()}
			fallback={
				<button
					type="button"
					class="mt-1 flex items-center gap-2 rounded bg-neutral-800 px-3 py-2 text-sm text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-neutral-300"
					onClick={(e) => {
						// Replace this button with the actual image
						const img = document.createElement("img");
						img.src = props.url;
						img.alt = props.alt;
						img.className = "mt-1 max-h-64 max-w-sm rounded";
						img.loading = "lazy";
						(e.currentTarget as HTMLElement).replaceWith(img);
					}}
					aria-label={`Load GIF: ${props.alt}`}
				>
					<span class="text-lg">🖼️</span>
					<span>Click to load GIF</span>
				</button>
			}
		>
			<img
				src={props.url}
				alt={props.alt}
				class="mt-1 max-h-64 max-w-sm rounded"
				loading="lazy"
			/>
		</Show>
	);
};

export default InlineGif;
