import { describe, expect, it } from "vitest";
import { validateMatrixUserId } from "./inviteValidation";

describe("validateMatrixUserId", () => {
	it("accepts a plain @local:server", () => {
		const r = validateMatrixUserId("@alice:matrix.org");
		expect(r).toEqual({ ok: true, userId: "@alice:matrix.org" });
	});

	it("trims surrounding whitespace", () => {
		const r = validateMatrixUserId("  @alice:matrix.org \t");
		expect(r).toEqual({ ok: true, userId: "@alice:matrix.org" });
	});

	it("accepts a server with an explicit port", () => {
		const r = validateMatrixUserId("@bob:example.com:8448");
		expect(r).toEqual({ ok: true, userId: "@bob:example.com:8448" });
	});

	it("accepts a server with the default HTTPS port", () => {
		// URL normalization strips `:443` from parsed.host; the validator
		// must tolerate this rather than reject the input.
		const r = validateMatrixUserId("@bob:example.com:443");
		expect(r).toEqual({ ok: true, userId: "@bob:example.com:443" });
	});

	it("accepts an IPv6 server literal with port", () => {
		const r = validateMatrixUserId("@bob:[::1]:8008");
		expect(r).toEqual({ ok: true, userId: "@bob:[::1]:8008" });
	});

	it("rejects an empty input", () => {
		const r = validateMatrixUserId("");
		expect(r.ok).toBe(false);
	});

	it("rejects whitespace-only input", () => {
		const r = validateMatrixUserId("   \t  ");
		expect(r.ok).toBe(false);
	});

	it("rejects input missing the leading @", () => {
		const r = validateMatrixUserId("alice:matrix.org");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(/@/);
	});

	it("rejects input with no colon", () => {
		const r = validateMatrixUserId("@alice");
		expect(r.ok).toBe(false);
	});

	it("rejects empty localpart", () => {
		const r = validateMatrixUserId("@:matrix.org");
		expect(r.ok).toBe(false);
	});

	it("rejects localpart containing a space", () => {
		const r = validateMatrixUserId("@a b:matrix.org");
		expect(r.ok).toBe(false);
	});

	it("rejects localpart containing a control character", () => {
		const r = validateMatrixUserId("@a\u0001b:matrix.org");
		expect(r.ok).toBe(false);
	});

	it("rejects localpart containing a tab", () => {
		const r = validateMatrixUserId("@a\tb:matrix.org");
		expect(r.ok).toBe(false);
	});

	it("rejects empty server", () => {
		const r = validateMatrixUserId("@alice:");
		expect(r.ok).toBe(false);
	});

	it("rejects server with whitespace", () => {
		const r = validateMatrixUserId("@alice: matrix.org");
		expect(r.ok).toBe(false);
	});

	it("rejects server with a path", () => {
		const r = validateMatrixUserId("@alice:matrix.org/admin");
		expect(r.ok).toBe(false);
	});

	it("rejects server with a query string", () => {
		const r = validateMatrixUserId("@alice:matrix.org?x=1");
		expect(r.ok).toBe(false);
	});

	it("rejects server with a fragment", () => {
		const r = validateMatrixUserId("@alice:matrix.org#frag");
		expect(r.ok).toBe(false);
	});

	it("rejects server with embedded credentials", () => {
		const r = validateMatrixUserId("@alice:user:pass@matrix.org");
		expect(r.ok).toBe(false);
	});

	it("rejects server with a trailing slash", () => {
		const r = validateMatrixUserId("@alice:matrix.org/");
		expect(r.ok).toBe(false);
	});

	it("rejects server with a leading slash", () => {
		const r = validateMatrixUserId("@alice:/matrix.org");
		expect(r.ok).toBe(false);
	});

	it("rejects server with a leading double slash", () => {
		const r = validateMatrixUserId("@alice://evil.com");
		expect(r.ok).toBe(false);
	});

	it("rejects server with a backslash", () => {
		const r = validateMatrixUserId("@alice:matrix.org\\admin");
		expect(r.ok).toBe(false);
	});

	it("rejects server with a control character", () => {
		const r = validateMatrixUserId("@alice:matrix.org\u0001");
		expect(r.ok).toBe(false);
	});

	it("rejects server with an embedded tab", () => {
		const r = validateMatrixUserId("@alice:matrix.org\tfoo");
		expect(r.ok).toBe(false);
	});
});
