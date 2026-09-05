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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRendition(value: unknown): GiphyRendition | undefined {
	if (!isRecord(value)) return undefined;
	return {
		url: typeof value.url === "string" ? value.url : undefined,
		width: typeof value.width === "string" ? value.width : undefined,
		height: typeof value.height === "string" ? value.height : undefined,
	};
}

function positiveDimension(value: string | undefined): number {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
}

function toGifItem(value: unknown): GifItem | null {
	if (!isRecord(value) || typeof value.id !== "string") return null;
	const images = value.images;
	if (!isRecord(images)) return null;

	const gif: GiphyGif = {
		id: value.id,
		title: typeof value.title === "string" ? value.title : "",
		images: {
			original: toRendition(images.original),
			fixed_width: toRendition(images.fixed_width),
			fixed_width_still: toRendition(images.fixed_width_still),
		},
	};
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
		width: positiveDimension(original.width),
		height: positiveDimension(original.height),
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
	const json: unknown = await res.json();
	if (!isRecord(json) || !Array.isArray(json.data)) {
		throw new Error("Giphy API returned an unexpected response shape");
	}
	const pagination = json.pagination;
	if (
		!isRecord(pagination) ||
		!Number.isInteger(pagination.total_count) ||
		!Number.isInteger(pagination.count) ||
		!Number.isInteger(pagination.offset) ||
		(pagination.total_count as number) < 0 ||
		(pagination.count as number) < 0 ||
		(pagination.offset as number) < 0 ||
		((pagination.count as number) === 0 &&
			(pagination.offset as number) < (pagination.total_count as number))
	) {
		throw new Error("Giphy API returned an unexpected response shape");
	}
	return json as unknown as GiphyResponse;
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
