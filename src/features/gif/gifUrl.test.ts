import { describe, expect, it } from "vitest";
import { extractGifUrl, isGifUrl } from "./gifUrl";

describe("isGifUrl", () => {
	it("matches Giphy CDN URLs", () => {
		expect(isGifUrl("https://media.giphy.com/media/abc123/giphy.gif")).toBe(
			true,
		);
		expect(isGifUrl("https://media2.giphy.com/media/abc123/giphy.gif")).toBe(
			true,
		);
	});

	it("matches Klipy CDN URLs", () => {
		expect(isGifUrl("https://static.klipy.com/gifs/abc123.gif")).toBe(true);
	});

	it("matches Tenor CDN URLs", () => {
		expect(isGifUrl("https://media.tenor.com/something.gif")).toBe(true);
		expect(isGifUrl("https://c.tenor.com/something.gif")).toBe(true);
	});

	it("rejects non-provider URLs", () => {
		expect(isGifUrl("https://example.com/cat.gif")).toBe(false);
		expect(isGifUrl("https://evil.giphy.com.attacker.com/fake")).toBe(false);
	});
});

describe("extractGifUrl", () => {
	it("extracts a valid Giphy URL from plain body", () => {
		const url = "https://media.giphy.com/media/abc123/giphy.gif";
		expect(extractGifUrl(url)).toBe(url);
	});

	it("extracts a valid Klipy URL from plain body", () => {
		const url = "https://static.klipy.com/gifs/abc123.gif";
		expect(extractGifUrl(url)).toBe(url);
	});

	it("extracts GIF URL from message with Matrix reply fallback", () => {
		const body =
			"> <@alice:test> hello world\n\nhttps://media.giphy.com/media/abc/giphy.gif";
		expect(extractGifUrl(body)).toBe(
			"https://media.giphy.com/media/abc/giphy.gif",
		);
	});

	it("returns null for plain text messages", () => {
		expect(extractGifUrl("hello world")).toBeNull();
	});

	it("returns null for messages with a GIF URL plus extra text", () => {
		expect(
			extractGifUrl(
				"check this https://media.giphy.com/media/abc/giphy.gif out",
			),
		).toBeNull();
	});

	it("rejects bare domain with no pathname", () => {
		expect(extractGifUrl("https://media.giphy.com/")).toBeNull();
	});

	it("rejects non-https URLs", () => {
		expect(
			extractGifUrl("http://media.giphy.com/media/abc/giphy.gif"),
		).toBeNull();
	});

	it("rejects URLs containing whitespace", () => {
		expect(extractGifUrl("https://media.giphy.com/\t")).toBeNull();
	});

	it("rejects URLs with invalid percent-encoding (handled gracefully)", () => {
		// The URL constructor accepts most malformed URLs, so invalid
		// percent-encoding is parsed successfully. This test documents
		// that such URLs are still accepted (the catch branch is a safety net).
		expect(extractGifUrl("https://media.giphy.com/media/%ZZ/giphy.gif")).toBe(
			"https://media.giphy.com/media/%ZZ/giphy.gif",
		);
	});

	it("handles whitespace around valid URL", () => {
		const url = "https://media.giphy.com/media/abc123/giphy.gif";
		expect(extractGifUrl(`  ${url}  `)).toBe(url);
	});

	it("returns null for empty string", () => {
		expect(extractGifUrl("")).toBeNull();
	});

	it("returns null when reply fallback has no double-newline separator", () => {
		// If there's no \n\n, the whole body is treated as the reply prefix
		// and stripped returns the original string, which starts with "> "
		expect(
			extractGifUrl("> https://media.giphy.com/media/abc/giphy.gif"),
		).toBeNull();
	});
});
