import { describe, expect, it } from "vitest";
import { isImageLink } from "./imageLink";

describe("direct image URLs", () => {
	it.each([
		["https://english.eve-guides.fr/images/wtd.jpg", true],
		["https://example.org/PHOTO.JPEG?token=abc#image", true],
		["https://example.org/p.png", true],
		["https://example.org/p.webp", true],
		["https://example.org/p.gif", true],
		["https://example.org/p.avif", true],
		["http://example.org/p.jpg", false],
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
