import { describe, expect, it } from "vitest";
import { type CustomEmoji, formatMarkdown, type Mention } from "./markdown";

/** Convenience: the formatted_body (asserting non-null). */
function html(
	text: string,
	mentions: Mention[] = [],
	emoji: CustomEmoji[] = [],
): string {
	const { formatted_body } = formatMarkdown(text, mentions, emoji);
	expect(formatted_body).not.toBeNull();
	return formatted_body as string;
}

describe("formatMarkdown — body passthrough + null contract", () => {
	it("always returns the raw text as body, unescaped", () => {
		expect(formatMarkdown("a < b & c").body).toBe("a < b & c");
	});

	it("returns null formatted_body for plain single-line text", () => {
		expect(formatMarkdown("hello world").formatted_body).toBeNull();
	});

	it("returns null for plain multi-line text", () => {
		expect(formatMarkdown("line one\nline two").formatted_body).toBeNull();
	});
});

describe("formatMarkdown — inline emphasis", () => {
	it("bold, italic (*), italic (_)", () => {
		expect(html("**b**")).toBe("<strong>b</strong>");
		expect(html("*i*")).toBe("<em>i</em>");
		expect(html("an _i_ word")).toBe("an <em>i</em> word");
	});

	it("strikethrough ~~ → <del>", () => {
		expect(html("~~gone~~")).toBe("<del>gone</del>");
	});

	it("bold wins over italic for **x**", () => {
		expect(html("**x**")).toBe("<strong>x</strong>");
	});

	it("escapes html in surrounding text", () => {
		expect(html("**a** < b")).toBe("<strong>a</strong> &lt; b");
	});
});

describe("formatMarkdown — code", () => {
	it("inline code is escaped and not further formatted", () => {
		expect(html("`a < *b*`")).toBe("<code>a &lt; *b*</code>");
	});

	it("fenced code block, language stripped, content escaped", () => {
		expect(html("```js\nconst x = 1 < 2;\n```")).toBe(
			"<pre><code>const x = 1 &lt; 2;\n</code></pre>",
		);
	});

	it("fenced code shields block markers (# / > / -) inside it", () => {
		const out = html("```\n# not a heading\n> not a quote\n- not a list\n```");
		expect(out).toContain("# not a heading");
		expect(out).not.toContain("<h1>");
		expect(out).not.toContain("<blockquote>");
		expect(out).not.toContain("<ul>");
	});
});

describe("formatMarkdown — headings", () => {
	it("h1–h6 with required space", () => {
		expect(html("# H1")).toBe("<h1>H1</h1>");
		expect(html("###### H6")).toBe("<h6>H6</h6>");
	});

	it("hashtag without a space stays inline text", () => {
		expect(formatMarkdown("#hashtag").formatted_body).toBeNull();
	});

	it("applies inline formatting inside the heading", () => {
		expect(html("## **bold** title")).toBe(
			"<h2><strong>bold</strong> title</h2>",
		);
	});
});

describe("formatMarkdown — blockquotes", () => {
	it("single line", () => {
		expect(html("> quoted")).toBe("<blockquote>quoted</blockquote>");
	});

	it("groups consecutive lines into one blockquote", () => {
		expect(html("> line one\n> line two")).toBe(
			"<blockquote>line one<br>line two</blockquote>",
		);
	});

	it("does not double-escape the marker (no &gt; leak)", () => {
		expect(html("> hi")).not.toContain("&gt;");
	});
});

describe("formatMarkdown — lists", () => {
	it("unordered list for -, *, +", () => {
		expect(html("- a\n* b\n+ c")).toBe(
			"<ul><li>a</li><li>b</li><li>c</li></ul>",
		);
	});

	it("*italic* (no trailing space) is not a list", () => {
		expect(html("*italic*")).toBe("<em>italic</em>");
	});

	it("ordered list starting at 1 omits the start attribute", () => {
		expect(html("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
	});

	it("ordered list adds start when first item != 1", () => {
		expect(html("3. a\n4. b")).toBe('<ol start="3"><li>a</li><li>b</li></ol>');
	});
});

describe("formatMarkdown — links (fail closed)", () => {
	it("http/https/mailto become anchors", () => {
		expect(html("[site](https://example.com)")).toBe(
			'<a href="https://example.com" target="_blank" rel="noreferrer noopener">site</a>',
		);
		expect(html("[mail](mailto:a@b.com)")).toContain('href="mailto:a@b.com"');
	});

	it("preserves query & and #fragment in the href", () => {
		expect(html("[x](https://e.com/p?a=1&b=2#frag)")).toContain(
			'href="https://e.com/p?a=1&amp;b=2#frag"',
		);
	});

	it("javascript: scheme renders as literal text, never an anchor", () => {
		const url = "javascript:alert(1)";
		const result = formatMarkdown(`[x](${url})`);
		expect(result.formatted_body).toBeNull();
	});

	it("escapes the link text", () => {
		expect(html("[<b>](https://e.com)")).toContain(">&lt;b&gt;</a>");
	});
});

describe("formatMarkdown — mentions & emoji", () => {
	const mention: Mention = { userId: "@bob:hs", displayName: "Bob" };
	const emoji: CustomEmoji = { shortcode: "party", mxcUrl: "mxc://hs/party" };

	it("renders a mention pill", () => {
		expect(html("hi @Bob", [mention])).toContain(
			'<a href="https://matrix.to/#/%40bob%3Ahs">@Bob</a>',
		);
	});

	it("does not linkify a mention inside inline code", () => {
		const out = html("`@Bob`", [mention]);
		expect(out).toBe("<code>@Bob</code>");
	});

	it("renders a custom emoji image", () => {
		expect(html(":party:", [], [emoji])).toContain("data-mx-emoticon");
		expect(html(":party:", [], [emoji])).toContain('src="mxc://hs/party"');
	});

	it("does not replace a shortcode inside inline code", () => {
		expect(html("`:party:`", [], [emoji])).toBe("<code>:party:</code>");
	});
});

describe("formatMarkdown — sentinel safety", () => {
	it("strips a user-typed replacement char without corrupting output", () => {
		// Only the sentinel char is dropped; the literal digits it surrounded
		// remain as ordinary text (no placeholder collision).
		expect(html("**b**�0�")).toBe("<strong>b</strong>0");
	});
});

describe("formatMarkdown — mixed block + text", () => {
	it("flushes a text run before a heading without a stray separator", () => {
		expect(html("intro\n# Title")).toBe("intro<h1>Title</h1>");
	});
});
