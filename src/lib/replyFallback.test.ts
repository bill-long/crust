import { describe, expect, it } from "vitest";
import { stripReplyFallback } from "./replyFallback";

describe("stripReplyFallback", () => {
	it("returns the body unchanged when there is no reply quote", () => {
		expect(stripReplyFallback("hello")).toBe("hello");
		expect(stripReplyFallback("> not a quote (no blank line)")).toBe(
			"> not a quote (no blank line)",
		);
		expect(stripReplyFallback("")).toBe("");
	});

	it("does not strip a reply-shaped block that appears later in the body", () => {
		// Without anchoring to position 0, a reply-shaped line in the
		// middle of a normal message would corrupt the prefix.
		const body = "hello\n> <@alice:example.com> hi\n\nreply";
		expect(stripReplyFallback(body)).toBe(body);
	});

	it("does not strip a bare blockquote without the sender line", () => {
		// Real user content that happens to lead with a blockquote should
		// be preserved — only spec-shaped reply fallbacks are stripped.
		const body = "> a quoted sentence\n\nfollowup paragraph";
		expect(stripReplyFallback(body)).toBe(body);
	});

	it("strips a single-line reply fallback", () => {
		const body = "> <@alice:example.com> hi\n\nhello";
		expect(stripReplyFallback(body)).toBe("hello");
	});

	it("strips a multi-line reply fallback", () => {
		const body = "> <@alice:example.com> line 1\n> line 2\n\nreply text";
		expect(stripReplyFallback(body)).toBe("reply text");
	});

	it("preserves blank lines inside the new content", () => {
		const body = "> <@alice:example.com> hi\n\nhello\n\nworld";
		expect(stripReplyFallback(body)).toBe("hello\n\nworld");
	});
});
