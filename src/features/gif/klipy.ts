import type { GifRating } from "../../types/config";
import type { GifItem, GifProvider, GifSearchResult } from "./types";

const KLIPY_BASE = "https://api.klipy.com/api/v1";
const DEFAULT_LIMIT = 24;

interface KlipyGif {
	id: string;
	slug: string;
	title: string;
	url: string;
	preview: string;
	width: number;
	height: number;
}

interface KlipyResponse {
	data: KlipyGif[];
	pagination: {
		total: number;
		per_page: number;
		current_page: number;
		next_page: number | null;
	};
}

// Klipy uses "level" values for content filtering
const RATING_TO_LEVEL: Record<GifRating, string> = {
	g: "1",
	pg: "2",
	"pg-13": "3",
	r: "4",
};

function toGifItem(gif: KlipyGif): GifItem | null {
	if (!gif.url) return null;
	return {
		id: gif.slug || gif.id,
		title: gif.title || "",
		url: gif.url,
		previewUrl: gif.preview || gif.url,
		stillUrl: gif.preview || gif.url,
		width: gif.width || 200,
		height: gif.height || 200,
	};
}

function buildUrl(
	apiKey: string,
	endpoint: string,
	page: number,
	perPage: number,
	rating: GifRating,
	query?: string,
): string {
	const params = new URLSearchParams({
		page: String(page),
		per_page: String(perPage),
		level: RATING_TO_LEVEL[rating],
	});
	if (query) params.set("q", query);
	return `${KLIPY_BASE}/${apiKey}/gifs/${endpoint}?${params}`;
}

async function fetchKlipy(url: string): Promise<KlipyResponse> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Klipy API error: ${res.status} ${res.statusText}`);
	}
	return res.json();
}

// Klipy uses page-based pagination; we normalize to offset-based.
// offset = (page - 1) * perPage, nextOffset = page * perPage
function toSearchResult(data: KlipyResponse, perPage: number): GifSearchResult {
	const items = data.data
		.map(toGifItem)
		.filter((item): item is GifItem => item !== null);
	const currentPage = data.pagination.current_page;
	return {
		items,
		hasMore: data.pagination.next_page !== null,
		nextOffset: currentPage * perPage,
	};
}

export function createKlipyProvider(apiKey: string): GifProvider {
	return {
		async search(
			query: string,
			rating: GifRating,
			offset = 0,
			limit = DEFAULT_LIMIT,
		): Promise<GifSearchResult> {
			const page = Math.floor(offset / limit) + 1;
			const url = buildUrl(apiKey, "search", page, limit, rating, query);
			const data = await fetchKlipy(url);
			return toSearchResult(data, limit);
		},

		async trending(
			rating: GifRating,
			offset = 0,
			limit = DEFAULT_LIMIT,
		): Promise<GifSearchResult> {
			const page = Math.floor(offset / limit) + 1;
			const url = buildUrl(apiKey, "trending", page, limit, rating);
			const data = await fetchKlipy(url);
			return toSearchResult(data, limit);
		},

		attribution: {
			name: "KLIPY",
			logoUrl: "https://klipy.com/images/klipy-logo.svg",
			url: "https://klipy.com",
			searchPlaceholder: "Search KLIPY",
		},
	};
}
