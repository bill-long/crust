import { afterEach, describe, expect, it, vi } from "vitest";
import { createGiphyProvider } from "./giphy";

function validResponse(overrides: Record<string, unknown> = {}) {
	return {
		data: [],
		pagination: { total_count: 0, count: 0, offset: 0 },
		...overrides,
	};
}

function mockJsonResponse(payload: unknown) {
	return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
		ok: true,
		json: async () => payload,
	} as Response);
}

describe("createGiphyProvider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("builds an encoded search request with the default pagination", async () => {
		const fetchMock = mockJsonResponse(validResponse());
		const provider = createGiphyProvider("key with spaces");

		await provider.search("cats & dogs", "pg-13");

		const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
		expect(requestUrl.pathname).toBe("/v1/gifs/search");
		expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
			api_key: "key with spaces",
			limit: "25",
			offset: "0",
			rating: "pg-13",
			bundle: "messaging_non_clips",
			q: "cats & dogs",
		});
	});

	it("builds a trending request without a query", async () => {
		const fetchMock = mockJsonResponse(validResponse());
		const provider = createGiphyProvider("test-key");

		await provider.trending("g", 50, 10);

		const requestUrl = new URL(String(fetchMock.mock.calls[0][0]));
		expect(requestUrl.pathname).toBe("/v1/gifs/trending");
		expect(Object.fromEntries(requestUrl.searchParams)).toEqual({
			api_key: "test-key",
			limit: "10",
			offset: "50",
			rating: "g",
			bundle: "messaging_non_clips",
		});
	});

	it("projects valid items and pagination", async () => {
		mockJsonResponse(
			validResponse({
				data: [
					{
						id: "cat-1",
						title: "Cat",
						images: {
							original: {
								url: "https://media.giphy.com/cat.gif",
								width: "480",
								height: "360",
							},
							fixed_width: {
								url: "https://media.giphy.com/cat-preview.gif",
							},
							fixed_width_still: {
								url: "https://media.giphy.com/cat.jpg",
							},
						},
					},
				],
				pagination: { total_count: 60, count: 25, offset: 25 },
			}),
		);

		const result = await createGiphyProvider("test-key").search("cat", "g");

		expect(result).toEqual({
			items: [
				{
					id: "cat-1",
					title: "Cat",
					url: "https://media.giphy.com/cat.gif",
					previewUrl: "https://media.giphy.com/cat-preview.gif",
					stillUrl: "https://media.giphy.com/cat.jpg",
					width: 480,
					height: 360,
				},
			],
			hasMore: true,
			nextOffset: 50,
		});
	});

	it("uses safe fallbacks for optional metadata", async () => {
		mockJsonResponse(
			validResponse({
				data: [
					{
						id: "fallback",
						title: null,
						images: {
							original: {
								url: "https://media.giphy.com/original.gif",
								width: "0",
								height: "not-a-number",
							},
							fixed_width: {
								url: "https://media.giphy.com/preview.gif",
							},
							fixed_width_still: { url: "http://example.com/still.jpg" },
						},
					},
				],
			}),
		);

		const result = await createGiphyProvider("test-key").trending("pg");

		expect(result.items[0]).toMatchObject({
			title: "",
			stillUrl: "https://media.giphy.com/preview.gif",
			width: 200,
			height: 200,
		});
	});

	it("filters malformed items and unsafe required URLs", async () => {
		mockJsonResponse(
			validResponse({
				data: [
					null,
					"not-an-item",
					{ id: 42, images: {} },
					{ id: "missing-images" },
					{
						id: "unsafe-original",
						images: {
							original: { url: "http://example.com/original.gif" },
							fixed_width: { url: "https://example.com/preview.gif" },
						},
					},
					{
						id: "unsafe-preview",
						images: {
							original: { url: "https://example.com/original.gif" },
							fixed_width: { url: "javascript:alert(1)" },
						},
					},
					{
						id: "valid",
						images: {
							original: { url: "https://example.com/original.gif" },
							fixed_width: { url: "https://example.com/preview.gif" },
						},
					},
				],
			}),
		);

		const result = await createGiphyProvider("test-key").search("cat", "g");

		expect(result.items.map((item) => item.id)).toEqual(["valid"]);
	});

	it("throws a descriptive error for an HTTP failure", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
		);

		await expect(
			createGiphyProvider("test-key").search("cat", "g"),
		).rejects.toThrow("Giphy API error: 403 Forbidden");
	});

	it.each([
		null,
		[],
		{},
		{ data: [] },
		{ data: {}, pagination: { total_count: 0, count: 0, offset: 0 } },
		{ data: [], pagination: null },
		{ data: [], pagination: { total_count: "1", count: 0, offset: 0 } },
		{ data: [], pagination: { total_count: 1, count: -1, offset: 0 } },
		{ data: [], pagination: { total_count: 1, count: 1, offset: 0.5 } },
	])("rejects an unexpected response shape: %j", async (payload) => {
		mockJsonResponse(payload);

		await expect(createGiphyProvider("test-key").trending("g")).rejects.toThrow(
			"Giphy API returned an unexpected response shape",
		);
	});

	it("exposes the required provider attribution", () => {
		expect(createGiphyProvider("test-key").attribution).toEqual({
			name: "GIPHY",
			logoUrl: "https://giphy.com/static/img/giphy-logo.svg",
			url: "https://giphy.com",
			searchPlaceholder: "Search GIPHY",
		});
	});
});
