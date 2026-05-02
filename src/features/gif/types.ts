import type { GifRating } from "../../types/config";

/** A single GIF result from any provider. */
export interface GifItem {
	/** Provider-specific ID. */
	id: string;
	/** Human-readable title. */
	title: string;
	/** CDN URL for the full-size GIF (sent in the message). */
	url: string;
	/** Smaller animated preview for the picker grid. */
	previewUrl: string;
	/** Static still image for when auto-download is off. */
	stillUrl: string;
	/** Original dimensions for aspect-ratio layout. */
	width: number;
	height: number;
}

export interface GifSearchResult {
	items: GifItem[];
	/** Whether more pages are available. */
	hasMore: boolean;
	/** Opaque cursor for the next page (provider-specific). */
	nextOffset: number;
}

export interface GifProviderAttribution {
	name: string;
	/** URL to the provider's logo (for "Powered by" display). */
	logoUrl: string;
	/** URL to the provider's website. */
	url: string;
	/** Required search field placeholder text (e.g., "Search KLIPY"). */
	searchPlaceholder: string;
}

/** Normalized interface for GIF search providers. */
export interface GifProvider {
	search(
		query: string,
		rating: GifRating,
		offset?: number,
		limit?: number,
	): Promise<GifSearchResult>;

	trending(
		rating: GifRating,
		offset?: number,
		limit?: number,
	): Promise<GifSearchResult>;

	attribution: GifProviderAttribution;
}
