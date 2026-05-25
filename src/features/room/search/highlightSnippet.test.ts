import { describe, expect, it } from "vitest";
import { buildSnippetHtml } from "./highlightSnippet";

describe("buildSnippetHtml", () => {
	it("returns an empty string for empty input", () => {
		expect(buildSnippetHtml("", ["foo"])).toBe("");
		expect(buildSnippetHtml("   ", ["foo"])).toBe("");
	});

	it("wraps matches in <mark> case-insensitively", () => {
		const html = buildSnippetHtml("Hello World hello", ["hello"]);
		expect(html).toContain("<mark>Hello</mark>");
		expect(html).toContain("<mark>hello</mark>");
		expect(html).toContain("World");
	});

	it("merges overlapping terms into a single <mark> without nesting", () => {
		const html = buildSnippetHtml("see foobar there", ["foo", "foobar"]);
		expect(html).toContain("<mark>foobar</mark>");
		expect(html).not.toContain("<mark><mark>");
		expect(html).not.toContain("</mark></mark>");
		const openCount = (html.match(/<mark>/g) ?? []).length;
		const closeCount = (html.match(/<\/mark>/g) ?? []).length;
		expect(openCount).toBe(closeCount);
		expect(openCount).toBe(1);
	});

	it("escapes HTML in the body so injected markup does not render", () => {
		const html = buildSnippetHtml("hi <script>alert(1)</script>", ["alert"]);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("<mark>alert</mark>");
	});

	it("strips disallowed tags via DOMPurify (no live <img> element)", () => {
		const html = buildSnippetHtml("a <img src=x onerror=y> b", ["img"]);
		// "<img" must not appear as an actual element — only escaped text.
		expect(html).not.toMatch(/<img\b/);
		expect(html).toContain("&lt;");
	});

	it("ignores reply-fallback quoted lines when locating the match", () => {
		const body = "> <@alice:example.com> hi\n\nthe answer is forty-two";
		const html = buildSnippetHtml(body, ["forty"]);
		expect(html).toContain("<mark>forty</mark>");
		expect(html).not.toContain("@alice");
	});

	it("returns a leading slice when no term matches (server may have stemmed it)", () => {
		const body = "the quick brown fox jumps over the lazy dog";
		const html = buildSnippetHtml(body, ["xyzzy"]);
		expect(html).toContain("the quick");
		expect(html).not.toContain("<mark>");
	});

	it("inserts ellipsis markers when the snippet is clipped", () => {
		const prefix = "x".repeat(200);
		const suffix = "y".repeat(200);
		const html = buildSnippetHtml(`${prefix} needle ${suffix}`, ["needle"]);
		expect(html).toContain("…");
		expect(html).toContain("<mark>needle</mark>");
	});

	it("collapses runs of whitespace to single spaces", () => {
		const html = buildSnippetHtml("hello   world\n\nagain", ["world"]);
		expect(html).not.toMatch(/ {2}/);
		expect(html).toContain("<mark>world</mark>");
	});

	it("ignores empty / whitespace terms", () => {
		const html = buildSnippetHtml("hello world", ["", "  ", "world"]);
		expect(html).toContain("<mark>world</mark>");
	});
});
