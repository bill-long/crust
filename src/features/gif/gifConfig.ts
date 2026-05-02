import { createMemo } from "solid-js";
import { useConfig } from "../../app/ConfigProvider";
import { userSettings } from "../../stores/settings";
import type { GifProvider, GifRating } from "../../types/config";

export interface GifConfigState {
	/** GIF search is enabled and has a valid API key. */
	available: () => boolean;
	/** The configured provider. */
	provider: () => GifProvider;
	/** API key for the provider. */
	apiKey: () => string;
	/** Whether to show trending GIFs when the picker opens. */
	trendingOnOpen: () => boolean;
	/** Maximum content rating to request from the provider. */
	maxRating: () => GifRating;
	/** Whether to auto-fetch GIF images from CDN (user preference). */
	autoDownload: () => boolean;
}

/**
 * Combined GIF configuration from operator config + user preferences.
 * Must be called within ConfigProvider.
 */
export function useGifConfig(): GifConfigState {
	const config = useConfig();

	const available = createMemo(
		() => config.gif.enabled && config.gif.apiKey.trim().length > 0,
	);

	return {
		available,
		provider: () => config.gif.provider,
		apiKey: () => config.gif.apiKey,
		trendingOnOpen: () => config.gif.trendingOnOpen,
		maxRating: () => config.gif.maxRating,
		autoDownload: () => userSettings().autoDownloadGifs,
	};
}
