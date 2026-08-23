import { describe, expect, it } from "vitest";
import {
	digestServiceWorkerScript,
	isNativeServiceWorkerUrl,
	NATIVE_SW_BUILD_PARAM,
	NATIVE_SW_MODE_PARAM,
	nativeServiceWorkerUrl,
} from "./nativeServiceWorker";

describe("digestServiceWorkerScript", () => {
	it("is stable for the same script and differs for a changed one", async () => {
		const a = await digestServiceWorkerScript("self.x = 1;");
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(await digestServiceWorkerScript("self.x = 1;")).toBe(a);
		expect(await digestServiceWorkerScript("self.x = 2;")).not.toBe(a);
	});
});

describe("nativeServiceWorkerUrl", () => {
	it("registers sw.js under the base path with the native flag and build id", () => {
		expect(nativeServiceWorkerUrl("/", "abc123")).toBe(
			"/sw.js?native=1&build=abc123",
		);
		expect(nativeServiceWorkerUrl("/crust/", "abc123")).toBe(
			"/crust/sw.js?native=1&build=abc123",
		);
	});

	it("changes with the build id, so a new build is a new registration", () => {
		expect(nativeServiceWorkerUrl("/", "one")).not.toBe(
			nativeServiceWorkerUrl("/", "two"),
		);
	});

	it("encodes a build id that is not URL-safe", () => {
		const url = new URL(nativeServiceWorkerUrl("/", "a b&c"), "http://x");
		expect(url.searchParams.get(NATIVE_SW_BUILD_PARAM)).toBe("a b&c");
		expect(url.searchParams.get(NATIVE_SW_MODE_PARAM)).toBe("1");
	});
});

describe("isNativeServiceWorkerUrl", () => {
	it("round-trips the URL the shell registers", () => {
		const url = new URL(
			nativeServiceWorkerUrl("/crust/", "abc123"),
			"http://tauri.localhost",
		);
		expect(isNativeServiceWorkerUrl(url.href)).toBe(true);
	});

	it("is false for the browser build's fixed worker URL", () => {
		expect(isNativeServiceWorkerUrl("https://strange.pizza/crust/sw.js")).toBe(
			false,
		);
		expect(isNativeServiceWorkerUrl("http://tauri.localhost/sw.js")).toBe(
			false,
		);
	});

	it("is false for an unparseable URL rather than throwing", () => {
		expect(isNativeServiceWorkerUrl("not a url")).toBe(false);
	});
});
