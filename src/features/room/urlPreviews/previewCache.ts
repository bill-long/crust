import type { MatrixClient } from "matrix-js-sdk";
import { canonicalizeUrl } from "../../../lib/extractUrls";

/**
 * Normalized OpenGraph data we render. Only fields we display are
 * captured; raw `IPreviewUrlResponse` keys (`og:*`) are mapped at
 * fetch time.
 */
export interface UrlPreviewData {
	title?: string;
	description?: string;
	site?: string;
	/** OpenGraph `og:type` (e.g. "video.other", "article"), when present. */
	type?: string;
	image?: {
		/** mxc:// URL only. External http(s) images are dropped for privacy. */
		mxcUrl: string;
		width?: number;
		height?: number;
		alt?: string;
	};
}

const MAX_RESOLVED_ENTRIES = 256;

/**
 * In-flight fetches keyed by canonical URL. Separate from `resolved`
 * so eviction can't drop an in-flight Promise (which would cause
 * duplicate requests). Entries are removed after the underlying
 * Promise settles, regardless of outcome.
 */
const inFlight = new Map<string, Promise<UrlPreviewData | null>>();

/**
 * LRU of settled results. `null` means "no useful preview" (empty
 * response or fetch error) — cached so we don't refetch on rerender.
 * Map insertion order is used as recency.
 */
const resolved = new Map<string, UrlPreviewData | null>();

function touchRecency(key: string, value: UrlPreviewData | null): void {
	if (resolved.has(key)) {
		resolved.delete(key);
	}
	resolved.set(key, value);
	while (resolved.size > MAX_RESOLVED_ENTRIES) {
		const oldest = resolved.keys().next().value;
		if (oldest === undefined) break;
		resolved.delete(oldest);
	}
}

function readString(
	obj: Record<string, unknown>,
	key: string,
): string | undefined {
	const v = obj[key];
	if (typeof v !== "string") return undefined;
	const trimmed = v.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readPositiveInt(
	obj: Record<string, unknown>,
	key: string,
): number | undefined {
	const v = obj[key];
	if (typeof v === "number" && Number.isFinite(v) && v > 0) {
		return Math.floor(v);
	}
	if (typeof v === "string") {
		const parsed = Number.parseInt(v, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

/**
 * Map a raw homeserver preview response into our normalized shape.
 * Returns null if nothing useful is present (no title, no description,
 * no usable mxc image).
 *
 * The thumbnail is mxc-only on purpose: rendering an external https
 * image would bypass the homeserver proxy and leak the user's IP to
 * the OG site, defeating the privacy model that the preview endpoint
 * exists to provide.
 */
function normalizePreview(raw: unknown): UrlPreviewData | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as Record<string, unknown>;

	const title = readString(obj, "og:title");
	const description = readString(obj, "og:description");
	const site = readString(obj, "og:site_name");
	const type = readString(obj, "og:type");

	const rawImage = readString(obj, "og:image");
	let image: UrlPreviewData["image"];
	if (rawImage?.startsWith("mxc://")) {
		image = {
			mxcUrl: rawImage,
			width: readPositiveInt(obj, "og:image:width"),
			height: readPositiveInt(obj, "og:image:height"),
			alt: readString(obj, "og:image:alt"),
		};
	}

	if (!title && !description && !image) return null;

	const data: UrlPreviewData = {};
	if (title) data.title = title;
	if (description) data.description = description;
	if (site) data.site = site;
	if (type) data.type = type;
	if (image) data.image = image;
	return Object.freeze(data);
}

/**
 * Fetch (or cache-hit) an OpenGraph preview for `rawUrl`.
 *
 * - Canonicalizes the URL for cache keying; returns null for invalid
 *   or unsupported-scheme URLs.
 * - Single in-flight Promise per canonical URL; concurrent callers
 *   share the same fetch.
 * - Settled results (including nulls) go into a 256-entry LRU.
 * - `ts` is the event timestamp; the homeserver may use it to fetch
 *   a historically-stable preview.
 */
export function getOrFetchPreview(
	client: MatrixClient,
	rawUrl: string,
	ts: number,
): Promise<UrlPreviewData | null> {
	const canonical = canonicalizeUrl(rawUrl);
	if (!canonical) return Promise.resolve(null);

	if (resolved.has(canonical)) {
		const cached = resolved.get(canonical) ?? null;
		touchRecency(canonical, cached);
		return Promise.resolve(cached);
	}

	const existing = inFlight.get(canonical);
	if (existing) return existing;

	const promise = (async (): Promise<UrlPreviewData | null> => {
		try {
			const raw = await client.getUrlPreview(canonical, ts);
			return normalizePreview(raw);
		} catch {
			return null;
		}
	})()
		.then((data) => {
			touchRecency(canonical, data);
			inFlight.delete(canonical);
			return data;
		})
		.catch((err) => {
			inFlight.delete(canonical);
			throw err;
		});

	inFlight.set(canonical, promise);
	return promise;
}

/**
 * Synchronously read a cached preview without triggering a fetch.
 * Returns `undefined` if not yet cached, `null` if we know there's
 * no useful preview, or the data otherwise.
 *
 * Currently unused by the UI (which goes through `createResource`),
 * but kept for potential prefetch / debugging use.
 */
export function peekPreview(rawUrl: string): UrlPreviewData | null | undefined {
	const canonical = canonicalizeUrl(rawUrl);
	if (!canonical) return null;
	if (!resolved.has(canonical)) return undefined;
	return resolved.get(canonical) ?? null;
}

/** Clear all cache state. Test-only. */
export function _resetPreviewCacheForTests(): void {
	inFlight.clear();
	resolved.clear();
}
