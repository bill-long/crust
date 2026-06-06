import type { MatrixClient } from "matrix-js-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetPreviewCacheForTests, getOrFetchPreview } from "./previewCache";

function makeClient(impl: (url: string, ts: number) => Promise<unknown>): {
	client: MatrixClient;
	spy: ReturnType<typeof vi.fn>;
} {
	const spy = vi.fn(impl);
	const client = { getUrlPreview: spy } as unknown as MatrixClient;
	return { client, spy };
}

describe("previewCache", () => {
	beforeEach(() => {
		_resetPreviewCacheForTests();
	});

	it("returns null for invalid URLs without calling the SDK", async () => {
		const { client, spy } = makeClient(async () => ({}));
		expect(
			await getOrFetchPreview(client, "javascript:alert(1)", 0),
		).toBeNull();
		expect(spy).not.toHaveBeenCalled();
	});

	it("caches a successful result and serves subsequent calls from cache", async () => {
		const { client, spy } = makeClient(async () => ({
			"og:title": "Hi",
			"og:image": "mxc://example.com/img",
		}));
		const first = await getOrFetchPreview(client, "https://example.com", 1);
		const second = await getOrFetchPreview(client, "https://example.com", 2);
		expect(first?.title).toBe("Hi");
		expect(first?.image?.mxcUrl).toBe("mxc://example.com/img");
		expect(second).toBe(first);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("drops non-mxc images", async () => {
		const { client } = makeClient(async () => ({
			"og:title": "Hi",
			"og:image": "https://evil.example/track.gif",
		}));
		const result = await getOrFetchPreview(client, "https://example.com", 0);
		expect(result?.image).toBeUndefined();
		expect(result?.title).toBe("Hi");
	});

	it("captures og:type when present", async () => {
		const { client } = makeClient(async () => ({
			"og:title": "Clip",
			"og:type": "video.other",
			"og:image": "mxc://example.com/v",
		}));
		const result = await getOrFetchPreview(client, "https://example.com", 0);
		expect(result?.type).toBe("video.other");
	});

	it("omits type when og:type is absent", async () => {
		const { client } = makeClient(async () => ({ "og:title": "Hi" }));
		const result = await getOrFetchPreview(client, "https://example.com", 0);
		expect(result?.type).toBeUndefined();
	});

	it("returns null when nothing useful is present", async () => {
		const { client } = makeClient(async () => ({}));
		expect(
			await getOrFetchPreview(client, "https://example.com", 0),
		).toBeNull();
	});

	it("caches errors as null and does not retry", async () => {
		const { client, spy } = makeClient(async () => {
			throw new Error("boom");
		});
		const first = await getOrFetchPreview(client, "https://example.com", 0);
		const second = await getOrFetchPreview(client, "https://example.com", 0);
		expect(first).toBeNull();
		expect(second).toBeNull();
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("dedupes concurrent in-flight requests for the same URL", async () => {
		let resolve!: (v: unknown) => void;
		const promise = new Promise<unknown>((r) => {
			resolve = r;
		});
		const { client, spy } = makeClient(() => promise);
		const a = getOrFetchPreview(client, "https://example.com", 0);
		const b = getOrFetchPreview(client, "https://example.com", 0);
		resolve({ "og:title": "Hi" });
		const [resA, resB] = await Promise.all([a, b]);
		expect(resA).toBe(resB);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("normalizes URL with fragment to share cache entry", async () => {
		const { client, spy } = makeClient(async () => ({ "og:title": "Hi" }));
		await getOrFetchPreview(client, "https://example.com/p#a", 0);
		await getOrFetchPreview(client, "https://example.com/p#b", 0);
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
