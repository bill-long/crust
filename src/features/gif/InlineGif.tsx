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
	/^https:\/\/static\.klipy\.com\//,
	// Tenor (for receiving GIFs from other clients)
	/^https:\/\/(?:media|c)\.tenor\.com\//,
];

/** Check if a URL is a known GIF provider CDN URL. */
export function isGifUrl(url: string): boolean {
	return GIF_URL_PATTERNS.some((re) => re.test(url));
}

/**
 * Extract a GIF CDN URL from a plain-text message body.
 * Matches when the message body (after stripping Matrix reply fallback)
 * is a single GIF URL with no other content.
 */
export function extractGifUrl(body: string): string | null {
	// Strip Matrix reply fallback: lines starting with "> " until the first
	// non-quoted line (the reply prefix format is "> <@user> text\n\n")
	let stripped = body;
	if (stripped.startsWith("> ")) {
		const endOfQuote = stripped.indexOf("\n\n");
		stripped = endOfQuote >= 0 ? stripped.slice(endOfQuote + 2) : stripped;
	}

	const trimmed = stripped.trim();
	if (isGifUrl(trimmed) && !/\s/.test(trimmed)) return trimmed;
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
				referrerPolicy="no-referrer"
			/>
		</Show>
	);
};

export default InlineGif;
