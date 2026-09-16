import { describe, expect, it } from "vitest";
import { imageViewerSource, isImageLink } from "./imageLink";

describe("direct image links", () => {
	it("honors video metadata over an image URL suffix", () => {
		expect(isImageLink("https://example.org/video.jpg", "video.other")).toBe(
			false,
		);
	});
	it.each([
		["http://example.org/image.jpg", null, null],
		[
			"http://example.org/image.jpg",
			"https://server/cached",
			"https://server/cached",
		],
		["http://example.org/image.jpg", "http://server/cached", null],
		["https://example.org/image.jpg", null, "https://example.org/image.jpg"],
		["https://example.org/article", null, null],
		[
			"https://example.org/article",
			"https://server/cached",
			"https://server/cached",
		],
	])(
		"selects a CSP-compatible viewer source for %s via %s",
		(source, cached, expected) => {
			expect(imageViewerSource(source as string, cached)).toBe(expected);
		},
	);
	it.each([
		["https://english.eve-guides.fr/images/wtd.jpg", true],
		["https://example.org/PHOTO.JPEG?token=abc#image", true],
		["https://example.org/p.png", true],
		["https://example.org/p.webp", true],
		["https://example.org/p.gif", true],
		["https://example.org/p.avif", true],
		["https://example.org/page?file=p.jpg", false],
		["https://example.org/p.jpg/other", false],
		["https://example.org/p.svg", false],
		["javascript:alert('p.jpg')", false],
		["file:///p.jpg", false],
		["not a URL", false],
	])("classifies %s", (url, expected) =>
		expect(isImageLink(url)).toBe(expected),
	);
});
