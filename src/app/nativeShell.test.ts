import { afterEach, describe, expect, it } from "vitest";
import { isNativeShell } from "./nativeShell";

describe("isNativeShell", () => {
	afterEach(() => {
		(window as { isTauri?: boolean }).isTauri = undefined;
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
