import type { MatrixClient } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import { avatarHttpUrl, avatarInitial } from "./avatar";

describe("avatarHttpUrl", () => {
	it("requests a square crop at the given size", () => {
		const mxcUrlToHttp = vi.fn().mockReturnValue("https://hs/thumb");
		const client = { mxcUrlToHttp } as unknown as MatrixClient;
		expect(avatarHttpUrl(client, "mxc://hs/abc", 48)).toBe("https://hs/thumb");
		expect(mxcUrlToHttp).toHaveBeenCalledWith("mxc://hs/abc", 48, 48, "crop");
	});

	it("returns null for a missing mxc without touching the client", () => {
		const mxcUrlToHttp = vi.fn();
		const client = { mxcUrlToHttp } as unknown as MatrixClient;
		expect(avatarHttpUrl(client, null, 48)).toBeNull();
		expect(avatarHttpUrl(client, undefined, 48)).toBeNull();
		expect(avatarHttpUrl(client, "", 48)).toBeNull();
		expect(mxcUrlToHttp).not.toHaveBeenCalled();
	});

	it('normalizes mxcUrlToHttp\'s "" sentinel (non-mxc input) to null', () => {
		const client = {
			mxcUrlToHttp: () => "",
		} as unknown as MatrixClient;
		expect(avatarHttpUrl(client, "https://not-an-mxc", 48)).toBeNull();
	});
});

describe("avatarInitial", () => {
	it("uppercases the first character of a display name", () => {
		expect(avatarInitial("alice")).toBe("A");
	});

	it("strips a leading Matrix sigil so raw IDs render their letter", () => {
		expect(avatarInitial("@alice:example.com")).toBe("A");
		expect(avatarInitial("#general:example.com")).toBe("G");
		expect(avatarInitial("!abc:example.com")).toBe("A");
	});

	it("strips the sigil from vanity names too - a deliberate trade-off", () => {
		// Call sites can't tell "#general:hs" (alias fallback, strip is an
		// improvement) from "#1 Fans" (human-chosen name); one rule for
		// both, pinned here so the choice is visible.
		expect(avatarInitial("#1 Fans")).toBe("1");
	});

	it("trims before stripping, so a padded MXID still loses the sigil", () => {
		expect(avatarInitial("  @alice:example.com")).toBe("A");
	});

	it("trims again after stripping, so a spaced sigil yields the letter", () => {
		expect(avatarInitial("@ alice")).toBe("A");
	});

	it("keeps an astral first character whole", () => {
		expect(avatarInitial("\u{1F431} cat")).toBe("\u{1F431}");
	});

	it("keeps a single glyph when uppercasing expands the code point", () => {
		// German sharp s uppercases to "SS"; the circle holds one glyph.
		expect(avatarInitial("ßeta")).toBe("S");
	});

	it("falls back to ? when nothing usable remains", () => {
		expect(avatarInitial("")).toBe("?");
		expect(avatarInitial("@")).toBe("?");
		expect(avatarInitial("   ")).toBe("?");
	});
});
