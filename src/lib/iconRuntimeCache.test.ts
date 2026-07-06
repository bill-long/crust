import { describe, expect, it } from "vitest";
import {
	ICON_FILENAMES,
	iconCacheUrls,
	isIconRequest,
} from "./iconRuntimeCache";

const ORIGIN = "https://example.com";

function url(path: string): URL {
	return new URL(path, ORIGIN);
}

describe("isIconRequest", () => {
	it("matches every icon filename under a sub-path base", () => {
		for (const name of ICON_FILENAMES) {
			expect(isIconRequest(url(`/crust/${name}`), "/crust/", ORIGIN)).toBe(
				true,
			);
		}
	});

	it("matches every icon filename under the root base", () => {
		for (const name of ICON_FILENAMES) {
			expect(isIconRequest(url(`/${name}`), "/", ORIGIN)).toBe(true);
		}
	});

	it("does not match a non-icon asset", () => {
		expect(isIconRequest(url("/crust/index.html"), "/crust/", ORIGIN)).toBe(
			false,
		);
		expect(
			isIconRequest(url("/crust/assets/logo-abc123.png"), "/crust/", ORIGIN),
		).toBe(false);
	});

	it("does not match an icon filename under a different base", () => {
		// The SW is scoped to `base`; an icon path outside it isn't ours to serve.
		expect(isIconRequest(url("/pwa-192.png"), "/crust/", ORIGIN)).toBe(false);
		expect(isIconRequest(url("/other/pwa-192.png"), "/crust/", ORIGIN)).toBe(
			false,
		);
	});

	it("does not match a cross-origin request for the same path", () => {
		expect(
			isIconRequest(
				new URL("/crust/pwa-192.png", "https://evil.example"),
				"/crust/",
				ORIGIN,
			),
		).toBe(false);
	});

	it("does not match when the icon name is only a suffix of the path", () => {
		// A path that ends with an icon filename but isn't exactly `${base}<name>`
		// must not match (guards against a naive endsWith check).
		expect(
			isIconRequest(url("/crust/nested/favicon.svg"), "/crust/", ORIGIN),
		).toBe(false);
		expect(isIconRequest(url("/crust/my-favicon.svg"), "/crust/", ORIGIN)).toBe(
			false,
		);
	});
});

describe("iconCacheUrls", () => {
	it("prefixes every icon filename with the sub-path base", () => {
		expect(iconCacheUrls("/crust/")).toEqual(
			ICON_FILENAMES.map((n) => `/crust/${n}`),
		);
	});

	it("prefixes every icon filename with the root base", () => {
		expect(iconCacheUrls("/")).toEqual(ICON_FILENAMES.map((n) => `/${n}`));
	});

	it("produces urls that isIconRequest matches under the same base", () => {
		// The warm-on-install urls and the route matcher must agree, or a warmed
		// entry would never be served (or vice versa).
		for (const u of iconCacheUrls("/crust/")) {
			expect(isIconRequest(new URL(u, ORIGIN), "/crust/", ORIGIN)).toBe(true);
		}
	});
});
