import type { GifRating } from "../../types/config";
import type { GifItem, GifProvider, GifSearchResult } from "./types";
import { isValidHttpsUrl } from "./urlValidation";

const KLIPY_BASE = "https://api.klipy.com/api/v1";
const DEFAULT_LIMIT = 24;

interface KlipyRendition {
	gif?: { url: string; width: number; height: number; size: number };
	webp?: { url: string; width: number; height: number; size: number };
	jpg?: { url: string; width: number; height: number; size: number };
}

interface KlipyGif {
	id: number;
	slug: string;
	title: string;
	file: {
		hd?: KlipyRendition;
		md?: KlipyRendition;
		sm?: KlipyRendition;
		xs?: KlipyRendition;
	};
}

interface KlipyResponse {
	result: boolean;
	data: {
		data: KlipyGif[];
		current_page: number;
		per_page: number;
		has_next: boolean;
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
	// Use hd gif for the sent URL, sm/xs for preview
	const hd = gif.file.hd?.gif ?? gif.file.md?.gif;
	const preview = gif.file.sm?.gif ?? gif.file.md?.gif ?? hd;
	const still = gif.file.sm?.jpg ?? gif.file.xs?.jpg;

	if (!hd?.url || !isValidHttpsUrl(hd.url)) return null;

	return {
		id: gif.slug || String(gif.id),
		title: gif.title || "",
		url: hd.url,
		previewUrl: preview?.url ?? hd.url,
		stillUrl: still?.url ?? preview?.url ?? hd.url,
		width: hd.width || 200,
		height: hd.height || 200,
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
	return `${KLIPY_BASE}/${encodeURIComponent(apiKey)}/gifs/${endpoint}?${params}`;
}

async function fetchKlipy(url: string): Promise<KlipyResponse> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Klipy API error: ${res.status} ${res.statusText}`);
	}
	return res.json();
}

function toSearchResult(data: KlipyResponse, perPage: number): GifSearchResult {
	const items = data.data.data
		.map(toGifItem)
		.filter((item): item is GifItem => item !== null);
	const currentPage = data.data.current_page;
	return {
		items,
		hasMore: data.data.has_next,
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
