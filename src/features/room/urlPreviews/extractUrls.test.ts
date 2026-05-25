import { describe, expect, it } from "vitest";
import {
	canonicalizeUrl,
	extractUrlsFromHtml,
	extractUrlsFromText,
	MAX_PREVIEWS_PER_MESSAGE,
	trimUrlTail,
} from "./extractUrls";

describe("trimUrlTail", () => {
	it("strips trailing prose punctuation", () => {
		expect(trimUrlTail("https://example.com.")).toBe("https://example.com");
		expect(trimUrlTail("https://example.com,")).toBe("https://example.com");
		expect(trimUrlTail("https://example.com!?")).toBe("https://example.com");
		expect(trimUrlTail("https://example.com'")).toBe("https://example.com");
		expect(trimUrlTail('https://example.com"')).toBe("https://example.com");
	});

	it("keeps balanced parens in URL", () => {
		expect(trimUrlTail("https://en.wikipedia.org/wiki/Foo_(bar)")).toBe(
			"https://en.wikipedia.org/wiki/Foo_(bar)",
		);
	});

	it("drops unbalanced trailing paren and following punctuation", () => {
		expect(trimUrlTail("https://example.com).")).toBe("https://example.com");
	});

	it("returns empty for empty input", () => {
		expect(trimUrlTail("")).toBe("");
	});
});

describe("canonicalizeUrl", () => {
	it("returns canonical form for http(s) URLs", () => {
		expect(canonicalizeUrl("https://example.com/")).toBe(
			"https://example.com/",
		);
		expect(canonicalizeUrl("http://example.com/foo")).toBe(
			"http://example.com/foo",
		);
	});

	it("drops fragments", () => {
		expect(canonicalizeUrl("https://example.com/p#section")).toBe(
			"https://example.com/p",
		);
	});

	it("rejects non-http(s) schemes", () => {
		expect(canonicalizeUrl("javascript:alert(1)")).toBeNull();
		expect(canonicalizeUrl("file:///etc/passwd")).toBeNull();
		expect(canonicalizeUrl("mailto:a@b.com")).toBeNull();
	});

	it("rejects malformed URLs", () => {
		expect(canonicalizeUrl("not a url")).toBeNull();
		expect(canonicalizeUrl("http://")).toBeNull();
	});

	it("rejects overlong URLs", () => {
		expect(
			canonicalizeUrl(`https://example.com/${"a".repeat(3000)}`),
		).toBeNull();
	});
});

describe("extractUrlsFromText", () => {
	it("extracts a single bare URL", () => {
		expect(extractUrlsFromText("check https://example.com out")).toEqual([
			"https://example.com",
		]);
	});

	it("handles prose punctuation around URLs", () => {
		expect(extractUrlsFromText("see (https://example.com).")).toEqual([
			"https://example.com",
		]);
	});

	it("preserves balanced parens", () => {
		expect(
			extractUrlsFromText("link https://en.wikipedia.org/wiki/Foo_(bar) here"),
		).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
	});

	it("dedupes URLs by canonical form", () => {
		expect(
			extractUrlsFromText("a https://example.com b https://example.com/#x"),
		).toEqual(["https://example.com"]);
	});

	it("caps at MAX_PREVIEWS_PER_MESSAGE", () => {
		const body = Array.from(
			{ length: MAX_PREVIEWS_PER_MESSAGE + 2 },
			(_, i) => `https://example${i}.com`,
		).join(" ");
		expect(extractUrlsFromText(body)).toHaveLength(MAX_PREVIEWS_PER_MESSAGE);
	});

	it("ignores URLs inside inline code", () => {
		expect(extractUrlsFromText("here is `https://example.com` inline")).toEqual(
			[],
		);
	});

	it("ignores URLs inside fenced code blocks", () => {
		expect(extractUrlsFromText("```\nhttps://example.com\n```")).toEqual([]);
	});

	it("strips reply-fallback quoted lines before extracting", () => {
		const body =
			"> <@alice:example.com> https://quoted.example\n\nreply https://reply.example";
		expect(extractUrlsFromText(body)).toEqual(["https://reply.example"]);
	});

	it("does not linkify mid-word strings", () => {
		expect(extractUrlsFromText("foohttps://example.com")).toEqual([]);
	});

	it("ignores non-http schemes", () => {
		expect(extractUrlsFromText("javascript:alert(1)")).toEqual([]);
		expect(extractUrlsFromText("matrix:r/foo:example.com")).toEqual([]);
	});
});

describe("extractUrlsFromHtml", () => {
	it("extracts hrefs from anchors", () => {
		expect(
			extractUrlsFromHtml('<a href="https://example.com">click</a>'),
		).toEqual(["https://example.com"]);
	});

	it("extracts bare URLs from text nodes", () => {
		expect(extractUrlsFromHtml("hello https://example.com world")).toEqual([
			"https://example.com",
		]);
	});

	it("ignores URLs inside <code>, <pre>, and <mx-reply>", () => {
		expect(
			extractUrlsFromHtml(
				"<code>https://code.example</code> <pre>https://pre.example</pre>" +
					"<mx-reply><blockquote>https://quoted.example</blockquote></mx-reply>",
			),
		).toEqual([]);
	});

	it("ignores URLs inside <script> and <style>", () => {
		expect(
			extractUrlsFromHtml(
				"<script>https://script.example</script>" +
					"<style>https://style.example</style>",
			),
		).toEqual([]);
	});

	it("extracts URLs from user-authored blockquotes (not mx-reply)", () => {
		expect(
			extractUrlsFromHtml(
				"<blockquote>see https://example.com for details</blockquote>",
			),
		).toEqual(["https://example.com"]);
	});

	it("dedupes between href and bare URL", () => {
		expect(
			extractUrlsFromHtml(
				'<a href="https://example.com">link</a> https://example.com',
			),
		).toEqual(["https://example.com"]);
	});

	it("rejects javascript: hrefs", () => {
		expect(
			extractUrlsFromHtml('<a href="javascript:alert(1)">click</a>'),
		).toEqual([]);
	});
});
