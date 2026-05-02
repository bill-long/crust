import type { GifConfig } from "../../types/config";
import { createGiphyProvider } from "./giphy";
import { createKlipyProvider } from "./klipy";
import type { GifProvider } from "./types";

/**
 * Create a GIF provider instance based on operator config.
 *
 * IMPORTANT — TOS compliance:
 * - Only one provider is active at a time. Both Giphy and Klipy TOS prohibit
 *   commingling their search results with another provider's results.
 * - GIFs must be served from the provider's CDN — no downloading/re-hosting
 *   to MXC or any other server.
 * - "Powered by [PROVIDER]" attribution must be visible in the picker UI.
 * - Klipy requires "Search KLIPY" as the search field placeholder.
 */
export function createGifProvider(config: GifConfig): GifProvider {
	switch (config.provider) {
		case "giphy":
			return createGiphyProvider(config.apiKey);
		case "klipy":
			return createKlipyProvider(config.apiKey);
	}
}
