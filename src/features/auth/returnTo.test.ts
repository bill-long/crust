import { describe, expect, it } from "vitest";
import { sanitizeReturnTo, toReturnToPath } from "./returnTo";

describe("toReturnToPath", () => {
	const loc = (pathname: string, search = "", hash = "") => ({
		pathname,
		search,
		hash,
	});

	it("returns the full path unchanged when there is no base", () => {
		expect(toReturnToPath(loc("/home/!r:x", "?thread=$t", "#f"), "")).toBe(
			"/home/!r:x?thread=$t#f",
		);
	});

	it("strips the Vite base so navigate() won't double it (sub-path hosting)", () => {
		// Under /crust/ hosting, useLocation().pathname is base-included; the
		// stored returnTo must be base-relative or navigate() would produce
		// /crust/crust/home/...
		expect(toReturnToPath(loc("/crust/home/!r:x"), "/crust")).toBe(
			"/home/!r:x",
		);
		expect(toReturnToPath(loc("/crust", "?a=1"), "/crust")).toBe("/?a=1");
	});
});

describe("sanitizeReturnTo", () => {
	it("passes through a normal in-app path (incl. query and hash)", () => {
		expect(sanitizeReturnTo("/home/!room:example.com")).toBe(
			"/home/!room:example.com",
		);
		expect(sanitizeReturnTo("/dm/!r:x?thread=$t")).toBe("/dm/!r:x?thread=$t");
		expect(sanitizeReturnTo("/space/!s:x/!r:x#frag")).toBe(
			"/space/!s:x/!r:x#frag",
		);
		expect(sanitizeReturnTo("/")).toBe("/");
	});

	it("falls back to / for non-string or empty input", () => {
		expect(sanitizeReturnTo(undefined)).toBe("/");
		expect(sanitizeReturnTo(null)).toBe("/");
		expect(sanitizeReturnTo(42)).toBe("/");
		expect(sanitizeReturnTo({ path: "/home" })).toBe("/");
		expect(sanitizeReturnTo("")).toBe("/");
	});

	it("rejects non-root-relative targets", () => {
		expect(sanitizeReturnTo("home/x")).toBe("/");
		expect(sanitizeReturnTo("https://evil.example/x")).toBe("/");
		expect(sanitizeReturnTo("javascript:alert(1)")).toBe("/");
	});

	it("rejects protocol-relative and backslash open-redirect tricks", () => {
		// These would otherwise resolve to an external origin.
		expect(sanitizeReturnTo("//evil.example")).toBe("/");
		expect(sanitizeReturnTo("//evil.example/path")).toBe("/");
		expect(sanitizeReturnTo("/\\evil.example")).toBe("/");
		expect(sanitizeReturnTo("/path\\to\\thing")).toBe("/");
	});

	it("rejects control chars (browsers strip them, can collapse to //)", () => {
		expect(sanitizeReturnTo("/\t//evil.example")).toBe("/");
		expect(sanitizeReturnTo("/\n/evil.example")).toBe("/");
		expect(sanitizeReturnTo("/home\r/x")).toBe("/");
	});

	it("does not bounce back to the login route", () => {
		expect(sanitizeReturnTo("/login")).toBe("/");
		expect(sanitizeReturnTo("/login/")).toBe("/");
		expect(sanitizeReturnTo("/login?returnTo=/x")).toBe("/");
		expect(sanitizeReturnTo("/login#x")).toBe("/");
	});

	it("does not over-reject paths that merely start with 'login'", () => {
		// A room/path whose name starts with "login" is a legitimate in-app path.
		expect(sanitizeReturnTo("/loginhelp")).toBe("/loginhelp");
	});
});
