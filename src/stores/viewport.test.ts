import { afterEach, describe, expect, it, vi } from "vitest";

// Minimal MediaQueryList stand-in. `viewport.ts` evaluates its listener wiring
// at import time, so each test stubs `matchMedia`, resets the module registry,
// and re-imports to exercise a fresh module instance.
interface FakeMql {
	matches: boolean;
	addEventListener?: ReturnType<typeof vi.fn>;
	addListener?: ReturnType<typeof vi.fn>;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

async function loadViewport(mql: FakeMql) {
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => mql),
	);
	vi.resetModules();
	return import("./viewport");
}

describe("viewport isMobile", () => {
	it("reflects the initial match and registers via addEventListener when available", async () => {
		const addEventListener = vi.fn();
		const { isMobile } = await loadViewport({
			matches: true,
			addEventListener,
			addListener: vi.fn(),
		});
		expect(isMobile()).toBe(true);
		expect(addEventListener).toHaveBeenCalledWith(
			"change",
			expect.any(Function),
		);
	});

	it("falls back to the deprecated addListener when addEventListener is absent", async () => {
		const addListener = vi.fn();
		const { isMobile } = await loadViewport({ matches: false, addListener });
		expect(isMobile()).toBe(false);
		expect(addListener).toHaveBeenCalledWith(expect.any(Function));
	});

	it("updates the signal when the media query change fires", async () => {
		let handler: ((e: { matches: boolean }) => void) | undefined;
		const addEventListener = vi.fn(
			(_event: string, h: (e: { matches: boolean }) => void) => {
				handler = h;
			},
		);
		const { isMobile } = await loadViewport({
			matches: false,
			addEventListener,
			addListener: vi.fn(),
		});
		expect(isMobile()).toBe(false);
		handler?.({ matches: true });
		expect(isMobile()).toBe(true);
	});

	it("defaults to desktop (false) when matchMedia is unavailable", async () => {
		// Exercise the `typeof window.matchMedia !== "function"` guard by
		// leaving matchMedia undefined (as on non-browser/older environments).
		vi.stubGlobal("matchMedia", undefined);
		vi.resetModules();
		const { isMobile } = await import("./viewport");
		expect(isMobile()).toBe(false);
	});
});
