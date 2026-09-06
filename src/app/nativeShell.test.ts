import { afterEach, describe, expect, it } from "vitest";
import { withPathname } from "../test/withPathname";
import { isNativeShell, isOverlayWindow } from "./nativeShell";

describe("isNativeShell", () => {
	afterEach(() => {
		delete (window as { isTauri?: boolean }).isTauri;
	});

	it("is false in a plain browser (no window.isTauri)", () => {
		expect(isNativeShell()).toBe(false);
	});

	it("is true when Tauri injects window.isTauri", () => {
		(window as { isTauri?: boolean }).isTauri = true;
		expect(isNativeShell()).toBe(true);
	});

	it("treats a non-true value as not the native shell", () => {
		(window as unknown as { isTauri?: unknown }).isTauri = "yes";
		expect(isNativeShell()).toBe(false);
	});
});

describe("isOverlayWindow", () => {
	const withPath = (pathname: string): boolean => {
		let result = false;
		withPathname(pathname, () => {
			result = isOverlayWindow();
		});
		return result;
	};

	it("is true only for the overlay route itself", () => {
		expect(withPath("/overlay")).toBe(true);
		expect(withPath("/overlay/")).toBe(true);
	});

	it("is false for a route that merely ends in /overlay", () => {
		// `/settings/*` is a splat route, so this is reachable - and a suffix
		// match here made the MAIN window hide both update cards for good.
		expect(withPath("/settings/overlay")).toBe(false);
	});

	it("is false for ordinary routes", () => {
		expect(withPath("/")).toBe(false);
		expect(withPath("/home/!room:example.org")).toBe(false);
	});
});
