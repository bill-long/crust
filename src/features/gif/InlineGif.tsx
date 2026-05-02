import { type Component, createMemo, createSignal, Show } from "solid-js";
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
 * Only matches when the entire message body is a single GIF URL
 * (with optional trailing whitespace). Messages with surrounding text
 * are rendered normally via MessageBody to preserve context.
 */
export function extractGifUrl(body: string): string | null {
	const trimmed = body.trim();
	if (isGifUrl(trimmed) && !trimmed.includes(" ")) return trimmed;
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
	const [manuallyLoaded, setManuallyLoaded] = createSignal(false);

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
