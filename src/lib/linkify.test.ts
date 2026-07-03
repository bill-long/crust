import { describe, expect, it } from "vitest";
import { linkifyTextNodes } from "./linkify";

function html(source: string): HTMLElement {
	const doc = new DOMParser().parseFromString(
		`<div>${source}</div>`,
		"text/html",
	);
	return doc.body.firstElementChild as HTMLElement;
}

function run(source: string): string {
	const root = html(source);
	linkifyTextNodes(root);
	return root.innerHTML;
}

describe("linkifyTextNodes", () => {
	it("anchors bare URLs in text nodes", () => {
		expect(run("see https://example.com here")).toBe(
			'see <a href="https://example.com" target="_blank" rel="noreferrer noopener">https://example.com</a> here',
		);
	});

	it("trims trailing prose punctuation from anchors", () => {
		expect(run("see (https://example.com).")).toBe(
			'see (<a href="https://example.com" target="_blank" rel="noreferrer noopener">https://example.com</a>).',
		);
	});

	it("does not touch URLs inside existing <a>", () => {
		const out = run('<a href="https://x">https://other.example</a>');
		expect(out).toBe('<a href="https://x">https://other.example</a>');
	});

	it("does not touch URLs inside <code> or <pre>", () => {
		expect(run("<code>https://example.com</code>")).toBe(
			"<code>https://example.com</code>",
		);
		expect(run("<pre>https://example.com</pre>")).toBe(
			"<pre>https://example.com</pre>",
		);
	});

	it("does not touch URLs inside <mx-reply>", () => {
		const out = run(
			"<mx-reply><blockquote>https://quoted.example</blockquote></mx-reply>after https://after.example",
		);
		expect(out).toContain("<mx-reply>");
		expect(out).toContain("<blockquote>https://quoted.example</blockquote>");
		expect(out).toContain(
			'<a href="https://after.example" target="_blank" rel="noreferrer noopener">https://after.example</a>',
		);
	});

	it("escapes ampersands in URL display text via textContent", () => {
		expect(run("https://example.com/?a=1&amp;b=2")).toBe(
			'<a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noreferrer noopener">https://example.com/?a=1&amp;b=2</a>',
		);
	});

	it("does not anchor mid-word URLs", () => {
		expect(run("foohttps://example.com")).toBe("foohttps://example.com");
	});

	it("handles multiple URLs in one text node", () => {
		const out = run("a https://one.example b https://two.example c");
		expect(out).toContain('href="https://one.example"');
		expect(out).toContain('href="https://two.example"');
	});

	it("rejects non-http(s) bare schemes", () => {
		expect(run("javascript:alert(1)")).toBe("javascript:alert(1)");
	});
});
