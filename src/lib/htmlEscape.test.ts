import { describe, expect, it } from "vitest";
import { escapeAttr, escapeHtml } from "./htmlEscape";

describe("escapeHtml", () => {
	it('escapes &, <, >, and "', () => {
		expect(escapeHtml('a & b < c > d " e')).toBe(
			"a &amp; b &lt; c &gt; d &quot; e",
		);
	});

	it("escapes ampersands before < and > so entity output is not double-escaped", () => {
		// A wrong ordering (& escaped LAST) would turn "<" into "&lt;" and then
		// re-escape that "&", yielding "&amp;lt;". Escaping "&" first keeps it as
		// "&lt;". Using a bare "<" (not "&lt;") is what makes this distinguishing.
		expect(escapeHtml("<")).toBe("&lt;");
		expect(escapeHtml(">")).toBe("&gt;");
		// A literal ampersand still escapes exactly once.
		expect(escapeHtml("a & b")).toBe("a &amp; b");
	});

	it("leaves single quotes and other characters untouched", () => {
		expect(escapeHtml("it's a <tag>")).toBe("it's a &lt;tag&gt;");
		expect(escapeHtml("")).toBe("");
	});

	it("neutralizes a script-injection attempt", () => {
		expect(escapeHtml('<script>alert("x")</script>')).toBe(
			"&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
		);
	});
});

describe("escapeAttr", () => {
	it('escapes only & and " (the characters unsafe in a quoted attribute)', () => {
		expect(escapeAttr('a"b&c')).toBe("a&quot;b&amp;c");
	});

	it("leaves < and > untouched (unlike escapeHtml)", () => {
		expect(escapeAttr("a<b>c")).toBe("a<b>c");
	});

	it("escapes ampersands first", () => {
		expect(escapeAttr('&"')).toBe("&amp;&quot;");
	});
});
