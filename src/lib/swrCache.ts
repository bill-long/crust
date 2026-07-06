/** The subset of the Cache API this module needs, so the stale-while-revalidate
 *  logic can be unit-tested against a fake without a real CacheStorage. */
export type CacheLike = {
	match(key: string): Promise<Response | undefined>;
	put(key: string, response: Response): Promise<void>;
};

/**
 * Stale-while-revalidate against a single cache entry keyed by `key`:
 *
 * - Cache hit: return the cached response immediately (instant, like a precache
 *   read) and refresh the entry in the background. The refresh is detached from
 *   the response we've already returned, so it is handed to `keepAlive` (wire
 *   this to the fetch event's `waitUntil`) - otherwise the service worker can be
 *   terminated once `respondWith` settles and the `cache.put` is dropped,
 *   leaving the icon stale across reloads.
 * - Cache miss: await the network and return the response. This promise is what
 *   the caller returns to `respondWith`, so the worker stays alive until the
 *   caching completes; no `keepAlive` is needed on this path.
 *
 * Caching is best-effort on both paths: a non-ok response is returned but never
 * cached (an error page must not become the sticky copy), and a `cache.put`
 * failure (storage quota, or a 206 the Cache API rejects) is swallowed so a
 * successfully-fetched response is still returned rather than turned into a
 * failed one.
 *
 * `key` is caller-normalized (the icon route passes the request pathname, with
 * any query string dropped) so varying queries can't spawn unbounded entries.
 */
export async function staleWhileRevalidate(
	cache: CacheLike,
	key: string,
	fetchFresh: () => Promise<Response>,
	keepAlive?: (background: Promise<unknown>) => void,
): Promise<Response> {
	const cached = await cache.match(key);
	const revalidate = fetchFresh().then(async (res) => {
		if (res.ok) {
			try {
				await cache.put(key, res.clone());
			} catch {
				// best-effort; the entry just isn't cached this round
			}
		}
		return res;
	});
	if (cached) {
		// Swallow the rejection unconditionally (we've already answered from
		// cache), then keep the worker alive until the background refresh settles,
		// else its cache.put can be dropped when the idle worker is terminated.
		// Attach the catch outside the optional call: `keepAlive?.(x)` skips
		// evaluating `x` when keepAlive is absent, which would leave the rejection
		// unhandled.
		const settled = revalidate.catch(() => {});
		keepAlive?.(settled);
		return cached;
	}
	return revalidate;
}
