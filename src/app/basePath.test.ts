import { describe, expect, it } from "vitest";
import { stripBasePath } from "./basePath";

describe("stripBasePath", () => {
	it("returns pathname unchanged when base is empty (root-hosted)", () => {
		expect(stripBasePath("/", "")).toBe("/");
		expect(stripBasePath("/settings", "")).toBe("/settings");
		expect(stripBasePath("/settings/account", "")).toBe("/settings/account");
	});

	it("strips the base prefix from a sub-path-hosted pathname", () => {
		expect(stripBasePath("/crust/settings", "/crust")).toBe("/settings");
		expect(stripBasePath("/crust/settings/account", "/crust")).toBe(
			"/settings/account",
		);
		expect(stripBasePath("/crust/home/!room:test", "/crust")).toBe(
			"/home/!room:test",
		);
	});

	it("returns '/' when pathname equals base exactly", () => {
		expect(stripBasePath("/crust", "/crust")).toBe("/");
	});

	it("returns pathname unchanged when it doesn't start with the base", () => {
		// Defensive: shouldn't happen in practice (the browser only routes
		// pathnames under the configured base to the SPA), but ensure we
		// don't mangle pathnames that don't match.
		expect(stripBasePath("/other", "/crust")).toBe("/other");
	});

	it("does not strip a base prefix that only matches as a substring", () => {
		// `/crustacean` must not become `acean` — base must be followed
		// by `/` or end-of-string.
		expect(stripBasePath("/crustacean", "/crust")).toBe("/crustacean");
	});

	it("handles multi-segment base paths", () => {
		expect(stripBasePath("/apps/crust/home", "/apps/crust")).toBe("/home");
	});
});
