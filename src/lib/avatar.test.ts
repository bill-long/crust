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

	it("strips the MXID sigil so a raw user ID renders its letter", () => {
		expect(avatarInitial("@alice:example.com")).toBe("A");
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

	it("falls back to ? when nothing usable remains", () => {
		expect(avatarInitial("")).toBe("?");
		expect(avatarInitial("@")).toBe("?");
		expect(avatarInitial("   ")).toBe("?");
	});
});
