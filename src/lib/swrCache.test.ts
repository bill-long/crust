import { describe, expect, it, vi } from "vitest";
import { type CacheLike, staleWhileRevalidate } from "./swrCache";

/** A minimal fake Response: only `ok` and `clone()` are read by the helper. */
function res(ok: boolean, tag: string): Response {
	const r = { ok, tag, clone: () => r };
	return r as unknown as Response;
}

function tagOf(response: Response): string {
	return (response as unknown as { tag: string }).tag;
}

function fakeCache(
	initial?: Array<[string, Response]>,
): CacheLike & { store: Map<string, Response> } {
	const store = new Map<string, Response>(initial);
	return {
		store,
		match: (key) => Promise.resolve(store.get(key)),
		put: (key, response) => {
			store.set(key, response);
			return Promise.resolve();
		},
	};
}

/** Let queued microtasks (the background revalidation) settle. */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("staleWhileRevalidate", () => {
	it("returns the cached response immediately on a hit", async () => {
		const cache = fakeCache([["/icon", res(true, "old")]]);
		const fetchFresh = vi.fn(() => Promise.resolve(res(true, "new")));

		const result = await staleWhileRevalidate(cache, "/icon", fetchFresh);

		expect(tagOf(result)).toBe("old");
		expect(fetchFresh).toHaveBeenCalledTimes(1);
	});

	it("refreshes the cache in the background after a hit", async () => {
		const cache = fakeCache([["/icon", res(true, "old")]]);
		const fetchFresh = () => Promise.resolve(res(true, "new"));

		await staleWhileRevalidate(cache, "/icon", fetchFresh);
		await flush();

		expect(tagOf(cache.store.get("/icon") as Response)).toBe("new");
	});

	it("does not reject when the background refresh fails after a hit", async () => {
		const cache = fakeCache([["/icon", res(true, "old")]]);
		const fetchFresh = () => Promise.reject(new Error("offline"));

		const result = await staleWhileRevalidate(cache, "/icon", fetchFresh);
		await flush();

		expect(tagOf(result)).toBe("old");
		// The stale entry survives a failed revalidation.
		expect(tagOf(cache.store.get("/icon") as Response)).toBe("old");
	});

	it("awaits the network and caches on a miss", async () => {
		const cache = fakeCache();
		const fetchFresh = () => Promise.resolve(res(true, "fetched"));

		const result = await staleWhileRevalidate(cache, "/icon", fetchFresh);

		expect(tagOf(result)).toBe("fetched");
		expect(tagOf(cache.store.get("/icon") as Response)).toBe("fetched");
	});

	it("returns but does not cache a non-ok response on a miss", async () => {
		const cache = fakeCache();
		const fetchFresh = () => Promise.resolve(res(false, "404"));

		const result = await staleWhileRevalidate(cache, "/icon", fetchFresh);

		expect(tagOf(result)).toBe("404");
		// An error response must not become the sticky cached copy.
		expect(cache.store.has("/icon")).toBe(false);
	});

	it("does not overwrite the cache with a non-ok revalidation after a hit", async () => {
		const cache = fakeCache([["/icon", res(true, "old")]]);
		const fetchFresh = () => Promise.resolve(res(false, "500"));

		await staleWhileRevalidate(cache, "/icon", fetchFresh);
		await flush();

		expect(tagOf(cache.store.get("/icon") as Response)).toBe("old");
	});

	it("returns the fetched response on a miss even if caching rejects", async () => {
		// A cache.put failure (quota, or a 206 the Cache API rejects) must not
		// turn a successfully-fetched icon into a failed response.
		const cache: CacheLike = {
			match: () => Promise.resolve(undefined),
			put: () => Promise.reject(new Error("QuotaExceeded")),
		};

		const result = await staleWhileRevalidate(cache, "/icon", () =>
			Promise.resolve(res(true, "fetched")),
		);

		expect(tagOf(result)).toBe("fetched");
	});

	it("hands the background refresh to keepAlive on a hit", async () => {
		const cache = fakeCache([["/icon", res(true, "old")]]);
		const keepAlive = vi.fn();

		await staleWhileRevalidate(
			cache,
			"/icon",
			() => Promise.resolve(res(true, "new")),
			keepAlive,
		);

		// Wired to event.waitUntil in the SW so the worker isn't terminated before
		// the background cache.put completes.
		expect(keepAlive).toHaveBeenCalledTimes(1);
		expect(keepAlive.mock.calls[0][0]).toBeInstanceOf(Promise);
		await flush();
		expect(tagOf(cache.store.get("/icon") as Response)).toBe("new");
	});

	it("does not call keepAlive on a miss", async () => {
		// The miss path returns the revalidation promise to respondWith directly,
		// which already keeps the worker alive until the put completes.
		const cache = fakeCache();
		const keepAlive = vi.fn();

		await staleWhileRevalidate(
			cache,
			"/icon",
			() => Promise.resolve(res(true, "x")),
			keepAlive,
		);

		expect(keepAlive).not.toHaveBeenCalled();
	});
});
