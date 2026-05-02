import { afterEach, describe, expect, it, vi } from "vitest";
import { createKlipyProvider } from "./klipy";

describe("createKlipyProvider", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("throws when API returns result: false", async () => {
		const mockResponse = { result: false, data: null };
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(mockResponse), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const provider = createKlipyProvider("test-api-key");
		await expect(provider.search("cats", "g")).rejects.toThrow(
			"Klipy API returned an error",
		);
	});

	it("throws when API returns unexpected response shape", async () => {
		const mockResponse = { result: true, data: { unexpected: "shape" } };
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(mockResponse), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const provider = createKlipyProvider("test-api-key");
		await expect(provider.search("cats", "g")).rejects.toThrow(
			"unexpected response shape",
		);
	});

	it("throws when pagination fields are missing", async () => {
		const mockResponse = {
			result: true,
			data: { data: [] },
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(mockResponse), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const provider = createKlipyProvider("test-api-key");
		await expect(provider.search("cats", "g")).rejects.toThrow(
			"unexpected response shape",
		);
	});

	it("throws when per_page is missing but other fields are valid", async () => {
		const mockResponse = {
			result: true,
			data: { data: [], current_page: 1, has_next: false },
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(mockResponse), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const provider = createKlipyProvider("test-api-key");
		await expect(provider.search("cats", "g")).rejects.toThrow(
			"unexpected response shape",
		);
	});

	it("throws when result is truthy but not boolean", async () => {
		const mockResponse = { result: "true", data: null };
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(mockResponse), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const provider = createKlipyProvider("test-api-key");
		await expect(provider.search("cats", "g")).rejects.toThrow(
			"unexpected response shape",
		);
	});

	it("throws on HTTP error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("Forbidden", { status: 403, statusText: "Forbidden" }),
		);

		const provider = createKlipyProvider("test-api-key");
		await expect(provider.search("cats", "g")).rejects.toThrow(
			"Klipy API error: 403",
		);
	});

	it("returns items from a valid response", async () => {
		const mockResponse = {
			result: true,
			data: {
				data: [
					{
						id: 1,
						slug: "test-gif",
						title: "Test GIF",
						file: {
							hd: {
								gif: {
									url: "https://static.klipy.com/gifs/hd.gif",
									width: 480,
									height: 360,
									size: 10000,
								},
							},
							sm: {
								gif: {
									url: "https://static.klipy.com/gifs/sm.gif",
									width: 240,
									height: 180,
									size: 5000,
								},
								jpg: {
									url: "https://static.klipy.com/gifs/sm.jpg",
									width: 240,
									height: 180,
									size: 2000,
								},
							},
						},
					},
				],
				current_page: 1,
				per_page: 24,
				has_next: false,
			},
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(mockResponse), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const provider = createKlipyProvider("test-api-key");
		const result = await provider.search("cats", "g");

		expect(result.items).toHaveLength(1);
		expect(result.items[0].id).toBe("test-gif");
		expect(result.items[0].url).toBe("https://static.klipy.com/gifs/hd.gif");
		expect(result.hasMore).toBe(false);
	});

	it("filters out null, non-object, and missing-file entries", async () => {
		const mockResponse = {
			result: true,
			data: {
				data: [
					null,
					"string",
					{ id: 1, slug: "no-file", title: "No file" },
					{
						id: 2,
						slug: "valid",
						title: "Valid",
						file: {
							hd: {
								gif: {
									url: "https://static.klipy.com/gifs/valid.gif",
									width: 480,
									height: 360,
									size: 10000,
								},
							},
						},
					},
				],
				current_page: 1,
				per_page: 24,
				has_next: false,
			},
		};
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify(mockResponse), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const provider = createKlipyProvider("test-api-key");
		const result = await provider.search("cats", "g");

		expect(result.items).toHaveLength(1);
		expect(result.items[0].id).toBe("valid");
	});
});
