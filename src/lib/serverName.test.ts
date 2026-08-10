import { describe, expect, it } from "vitest";
import { isValidServerName } from "./serverName";

describe("isValidServerName", () => {
	it("accepts a plain hostname", () => {
		expect(isValidServerName("matrix.org")).toBe(true);
	});

	it("accepts a host with an explicit port", () => {
		expect(isValidServerName("example.com:8448")).toBe(true);
	});

	it("accepts the default HTTPS port (URL normalization strips it)", () => {
		expect(isValidServerName("example.com:443")).toBe(true);
	});

	it("accepts an IPv6 literal with port", () => {
		expect(isValidServerName("[::1]:8008")).toBe(true);
	});

	it("rejects an empty string", () => {
		expect(isValidServerName("")).toBe(false);
	});

	it("rejects a trailing path separator", () => {
		// The URL parser strips "matrix.org/" to host "matrix.org"; the
		// pre-check must reject the "/" before the round-trip.
		expect(isValidServerName("matrix.org/")).toBe(false);
	});

	it("rejects a leading separator", () => {
		expect(isValidServerName("//evil.com")).toBe(false);
		expect(isValidServerName("/matrix.org")).toBe(false);
	});

	it("rejects query/fragment injection", () => {
		expect(isValidServerName("matrix.org?x=1")).toBe(false);
		expect(isValidServerName("matrix.org#frag")).toBe(false);
	});

	it("rejects userinfo markers", () => {
		expect(isValidServerName("user@matrix.org")).toBe(false);
	});

	it("rejects whitespace and control characters", () => {
		expect(isValidServerName("matrix .org")).toBe(false);
		expect(isValidServerName("matrix.org\n")).toBe(false);
		expect(isValidServerName("matrix.org\x7f")).toBe(false);
	});

	it("rejects backslashes", () => {
		expect(isValidServerName("matrix.org\\evil.com")).toBe(false);
	});
});
