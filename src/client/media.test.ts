import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { createMediaFetcher } from "./media";

afterEach(() => vi.unstubAllGlobals());

it("binds media authentication to its owning client and uses refreshed tokens", async () => {
	let token = "alice";
	const client = {
		baseUrl: "https://hs.example",
		getAccessToken: () => token,
		isVersionSupported: async () => true,
	} as unknown as MatrixClient;
	const fetcher = createMediaFetcher(client);
	const requests: { url: string; auth: string | null }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			requests.push({
				url,
				auth: new Headers(init.headers).get("Authorization"),
			});
			return new Response("bytes");
		}),
	);
	const media = "/_matrix/media/v3/download/remote.example/file";
	await fetcher(client.baseUrl + media);
	token = "alice-refreshed";
	await fetcher(client.baseUrl + media);
	await fetcher(`https://other.example${media}`);
	expect(requests).toEqual([
		{
			url: "https://hs.example/_matrix/client/v1/media/download/remote.example/file",
			auth: "Bearer alice",
		},
		{
			url: "https://hs.example/_matrix/client/v1/media/download/remote.example/file",
			auth: "Bearer alice-refreshed",
		},
		{ url: `https://other.example${media}`, auth: null },
	]);
	token = "";
	await expect(fetcher(client.baseUrl + media)).rejects.toThrow(
		"Sign in again",
	);
	expect(requests).toHaveLength(3);
});

it("does not retry failed authenticated requests through legacy media", async () => {
	const client = {
		baseUrl: "https://hs",
		getAccessToken: () => "token",
		isVersionSupported: async () => true,
	} as unknown as MatrixClient;
	const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
	vi.stubGlobal("fetch", fetchMock);
	await expect(
		createMediaFetcher(client)("https://hs/_matrix/media/v3/download/hs/id"),
	).rejects.toThrow();
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const abort = new AbortController();
	abort.abort();
	await expect(
		createMediaFetcher(client)(
			"https://hs/_matrix/media/v3/download/hs/id",
			abort.signal,
		),
	).rejects.toThrow();
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("does not downgrade to legacy media when the version probe fails", async () => {
	const client = {
		baseUrl: "https://hs",
		getAccessToken: () => "token",
		isVersionSupported: async () => {
			throw new TypeError("Failed to fetch");
		},
	} as unknown as MatrixClient;
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	await expect(
		createMediaFetcher(client)("https://hs/_matrix/media/v3/download/hs/id"),
	).rejects.toThrow("Failed to fetch");
	expect(fetchMock).not.toHaveBeenCalled();
});
