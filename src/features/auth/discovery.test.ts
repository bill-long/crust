import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverHomeserver } from "./discovery";

// discoverHomeserver reaches for global fetch to look up
// /.well-known/matrix/client. Each test stubs it with a specific outcome
// (well-known hit, miss, or network error) and restores afterward.
afterEach(() => {
	vi.unstubAllGlobals();
});

/** Stub fetch to resolve with a well-known JSON body and given `ok`. */
function stubWellKnown(body: unknown, ok = true): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async () => ({
		ok,
		json: async () => body,
	}));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

/** Stub fetch to reject, simulating an unreachable .well-known. */
function stubNetworkError(): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async () => {
		throw new Error("network down");
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("discoverHomeserver", () => {
	describe("well-known discovery", () => {
		it("returns the m.homeserver base_url when .well-known resolves it", async () => {
			const fetchMock = stubWellKnown({
				"m.homeserver": { base_url: "https://matrix.strange.pizza" },
			});
			await expect(discoverHomeserver("strange.pizza")).resolves.toBe(
				"https://matrix.strange.pizza",
			);
			expect(fetchMock).toHaveBeenCalledWith(
				"https://strange.pizza/.well-known/matrix/client",
			);
		});

		it("strips trailing slashes from the discovered base_url", async () => {
			stubWellKnown({
				"m.homeserver": { base_url: "https://matrix.strange.pizza///" },
			});
			await expect(discoverHomeserver("strange.pizza")).resolves.toBe(
				"https://matrix.strange.pizza",
			);
		});

		it("always queries .well-known over HTTPS even for an http:// input", async () => {
			const fetchMock = stubWellKnown({
				"m.homeserver": { base_url: "https://matrix.example.org" },
			});
			await discoverHomeserver("http://example.org");
			expect(fetchMock).toHaveBeenCalledWith(
				"https://example.org/.well-known/matrix/client",
			);
		});
	});

	describe("input parsing", () => {
		it("extracts the server from an @user:server MXID", async () => {
			const fetchMock = stubWellKnown({}, false);
			await expect(discoverHomeserver("@alice:strange.pizza")).resolves.toBe(
				"https://strange.pizza",
			);
			expect(fetchMock).toHaveBeenCalledWith(
				"https://strange.pizza/.well-known/matrix/client",
			);
		});

		it("handles an @-prefixed input with no colon (treated as the host)", async () => {
			// "@strange.pizza" has no ':' to split on, so the raw value flows into
			// URL parsing where the "@" is read as empty userinfo, leaving the host.
			const fetchMock = stubWellKnown({}, false);
			await expect(discoverHomeserver("@strange.pizza")).resolves.toBe(
				"https://strange.pizza",
			);
			expect(fetchMock).toHaveBeenCalledWith(
				"https://strange.pizza/.well-known/matrix/client",
			);
		});

		it("accepts a full https:// URL and uses its host", async () => {
			stubWellKnown({}, false);
			await expect(discoverHomeserver("https://strange.pizza")).resolves.toBe(
				"https://strange.pizza",
			);
		});

		it("preserves an explicit http scheme when .well-known misses", async () => {
			stubWellKnown({}, false);
			await expect(discoverHomeserver("http://strange.pizza")).resolves.toBe(
				"http://strange.pizza",
			);
		});

		it("strips path, query, and fragment down to the host", async () => {
			const fetchMock = stubWellKnown({}, false);
			await expect(
				discoverHomeserver("strange.pizza/foo/bar?x=1#frag"),
			).resolves.toBe("https://strange.pizza");
			expect(fetchMock).toHaveBeenCalledWith(
				"https://strange.pizza/.well-known/matrix/client",
			);
		});

		it("trims surrounding whitespace", async () => {
			const fetchMock = stubWellKnown({}, false);
			await discoverHomeserver("  strange.pizza  ");
			expect(fetchMock).toHaveBeenCalledWith(
				"https://strange.pizza/.well-known/matrix/client",
			);
		});
	});

	describe("fallback to the direct URL", () => {
		it("falls back to https://<server> when .well-known returns non-ok", async () => {
			stubWellKnown({}, false);
			await expect(discoverHomeserver("strange.pizza")).resolves.toBe(
				"https://strange.pizza",
			);
		});

		it("falls back when the .well-known fetch throws (network error)", async () => {
			stubNetworkError();
			await expect(discoverHomeserver("strange.pizza")).resolves.toBe(
				"https://strange.pizza",
			);
		});

		it("falls back when the body has no m.homeserver.base_url", async () => {
			stubWellKnown({ "m.homeserver": {} });
			await expect(discoverHomeserver("strange.pizza")).resolves.toBe(
				"https://strange.pizza",
			);
		});

		it("ignores a non-http(s) base_url and falls back", async () => {
			// A malicious/misconfigured .well-known must not redirect us to a
			// non-http scheme.
			stubWellKnown({ "m.homeserver": { base_url: "ftp://evil.example" } });
			await expect(discoverHomeserver("strange.pizza")).resolves.toBe(
				"https://strange.pizza",
			);
		});

		it("ignores a malformed base_url and falls back", async () => {
			stubWellKnown({ "m.homeserver": { base_url: "not a url" } });
			await expect(discoverHomeserver("strange.pizza")).resolves.toBe(
				"https://strange.pizza",
			);
		});

		it("falls back when the response body is not valid JSON", async () => {
			const fetchMock = vi.fn(async () => ({
				ok: true,
				json: async () => {
					throw new Error("invalid json");
				},
			}));
			vi.stubGlobal("fetch", fetchMock);
			await expect(discoverHomeserver("strange.pizza")).resolves.toBe(
				"https://strange.pizza",
			);
		});
	});

	describe("invalid input", () => {
		it("rejects empty input without touching the network", async () => {
			// Parsing must fail before any .well-known fetch: stub it and assert
			// it was never called.
			const fetchMock = stubWellKnown({}, false);
			await expect(discoverHomeserver("")).rejects.toThrow(
				"Please enter a homeserver address.",
			);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("rejects whitespace-only input without touching the network", async () => {
			const fetchMock = stubWellKnown({}, false);
			await expect(discoverHomeserver("   ")).rejects.toThrow(
				"Please enter a homeserver address.",
			);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("rejects a non-empty but unparseable hostname", async () => {
			// An embedded space makes both the initial parse and the second
			// validation `new URL()` throw, so we reach the "valid homeserver
			// address" guard rather than the empty-input one - and never fetch.
			const fetchMock = stubWellKnown({}, false);
			await expect(discoverHomeserver("strange pizza")).rejects.toThrow(
				"Please enter a valid homeserver address.",
			);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("rejects an unparseable hostname carrying an explicit scheme", async () => {
			// Drives the explicit-scheme branch of the first-parse catch block
			// (scheme detection) before the validation guard throws.
			const fetchMock = stubWellKnown({}, false);
			await expect(discoverHomeserver("http://strange pizza")).rejects.toThrow(
				"Please enter a valid homeserver address.",
			);
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});
});
