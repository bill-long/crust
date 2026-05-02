import type { GifRating } from "../../types/config";
import type { GifItem, GifProvider, GifSearchResult } from "./types";
import { isValidHttpsUrl } from "./urlValidation";

const GIPHY_BASE = "https://api.giphy.com/v1/gifs";
const DEFAULT_LIMIT = 25;

// Giphy rendition types we care about
interface GiphyRendition {
	url?: string;
	width?: string;
	height?: string;
}

interface GiphyGif {
	id: string;
	title: string;
	images: {
		original?: GiphyRendition;
		fixed_width?: GiphyRendition;
		fixed_width_still?: GiphyRendition;
	};
}

interface GiphyResponse {
	data: GiphyGif[];
	pagination: {
		total_count: number;
		count: number;
		offset: number;
	};
}

function toGifItem(gif: GiphyGif): GifItem | null {
	const original = gif.images.original;
	const preview = gif.images.fixed_width;
	const still = gif.images.fixed_width_still;

	if (!original?.url || !preview?.url) return null;
	if (!isValidHttpsUrl(original.url) || !isValidHttpsUrl(preview.url))
		return null;

	return {
		id: gif.id,
		title: gif.title || "",
		url: original.url,
		previewUrl: preview.url,
		stillUrl:
			still?.url && isValidHttpsUrl(still.url) ? still.url : preview.url,
		width: Number.parseInt(original.width ?? "0", 10) || 200,
		height: Number.parseInt(original.height ?? "0", 10) || 200,
	};
}

function buildUrl(
	endpoint: string,
	apiKey: string,
	rating: GifRating,
	offset: number,
	limit: number,
	query?: string,
): string {
	const params = new URLSearchParams({
		api_key: apiKey,
		limit: String(limit),
		offset: String(offset),
		rating,
		bundle: "messaging_non_clips",
	});
	if (query) params.set("q", query);
	return `${GIPHY_BASE}/${endpoint}?${params}`;
}

async function fetchGiphy(url: string): Promise<GiphyResponse> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Giphy API error: ${res.status} ${res.statusText}`);
	}
	return res.json();
}

function toSearchResult(data: GiphyResponse): GifSearchResult {
	const items = data.data
		.map(toGifItem)
		.filter((item): item is GifItem => item !== null);
	const nextOffset = data.pagination.offset + data.pagination.count;
	return {
		items,
		hasMore: nextOffset < data.pagination.total_count,
		nextOffset,
	};
}

export function createGiphyProvider(apiKey: string): GifProvider {
	return {
		async search(
			query: string,
			rating: GifRating,
			offset = 0,
			limit = DEFAULT_LIMIT,
		): Promise<GifSearchResult> {
			const url = buildUrl("search", apiKey, rating, offset, limit, query);
			const data = await fetchGiphy(url);
			return toSearchResult(data);
		},

		async trending(
			rating: GifRating,
			offset = 0,
			limit = DEFAULT_LIMIT,
		): Promise<GifSearchResult> {
			const url = buildUrl("trending", apiKey, rating, offset, limit);
			const data = await fetchGiphy(url);
			return toSearchResult(data);
		},

		attribution: {
			name: "GIPHY",
			logoUrl: "https://giphy.com/static/img/giphy-logo.svg",
			url: "https://giphy.com",
			searchPlaceholder: "Search GIPHY",
		},
	};
}
