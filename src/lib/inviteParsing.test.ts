import { describe, expect, it } from "vitest";
import { parseInvites } from "./inviteParsing";

describe("parseInvites", () => {
	it("returns no mxids and no error for empty or separator-only input", () => {
		expect(parseInvites("", null)).toEqual({ mxids: [], error: null });
		expect(parseInvites("   ", null)).toEqual({ mxids: [], error: null });
		expect(parseInvites(" , ; ", null)).toEqual({ mxids: [], error: null });
	});

	it("parses a single valid Matrix user ID", () => {
		expect(parseInvites("@alice:example.com", null)).toEqual({
			mxids: ["@alice:example.com"],
			error: null,
		});
	});

	it("splits on whitespace, commas, and semicolons", () => {
		expect(
			parseInvites("@a:example.com, @b:example.com; @c:example.com", null),
		).toEqual({
			mxids: ["@a:example.com", "@b:example.com", "@c:example.com"],
			error: null,
		});
	});

	it("dedupes repeated ids preserving first-seen order", () => {
		expect(
			parseInvites("@a:example.com @b:example.com @a:example.com", null),
		).toEqual({
			mxids: ["@a:example.com", "@b:example.com"],
			error: null,
		});
	});

	it("drops the caller's own id", () => {
		expect(
			parseInvites("@me:example.com @a:example.com", "@me:example.com"),
		).toEqual({ mxids: ["@a:example.com"], error: null });
	});

	it("returns the first invalid token's error and no mxids", () => {
		// Second token is invalid; the whole parse fails with that token's error.
		const result = parseInvites("@a:example.com notauser", null);
		expect(result.mxids).toEqual([]);
		expect(result.error).toBe("notauser: User ID must start with @.");
	});
});
