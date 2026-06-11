import { afterEach, describe, expect, it, vi } from "vitest";
import { updateAppBadge } from "./appBadge";

type BadgeNav = Navigator & {
	setAppBadge?: (n?: number) => Promise<void>;
	clearAppBadge?: () => Promise<void>;
};

afterEach(() => {
	// `delete navigator.setAppBadge` is rejected by TS (the Badging API methods
	// are typed as required on Navigator), so delete through an index-typed view.
	const nav = navigator as unknown as Record<string, unknown>;
	delete nav.setAppBadge;
	delete nav.clearAppBadge;
	vi.restoreAllMocks();
});

describe("updateAppBadge", () => {
	it("sets the badge to the count when positive", () => {
		const nav = navigator as BadgeNav;
		const setAppBadge = vi.fn().mockResolvedValue(undefined);
		const clearAppBadge = vi.fn().mockResolvedValue(undefined);
		nav.setAppBadge = setAppBadge;
		nav.clearAppBadge = clearAppBadge;

		updateAppBadge(5);

		expect(setAppBadge).toHaveBeenCalledWith(5);
		expect(clearAppBadge).not.toHaveBeenCalled();
	});

	it("clears the badge when the count is zero", () => {
		const nav = navigator as BadgeNav;
		const setAppBadge = vi.fn().mockResolvedValue(undefined);
		const clearAppBadge = vi.fn().mockResolvedValue(undefined);
		nav.setAppBadge = setAppBadge;
		nav.clearAppBadge = clearAppBadge;

		updateAppBadge(0);

		expect(clearAppBadge).toHaveBeenCalledTimes(1);
		expect(setAppBadge).not.toHaveBeenCalled();
	});

	it("clears the badge for a negative count rather than setting it", () => {
		const nav = navigator as BadgeNav;
		const setAppBadge = vi.fn().mockResolvedValue(undefined);
		const clearAppBadge = vi.fn().mockResolvedValue(undefined);
		nav.setAppBadge = setAppBadge;
		nav.clearAppBadge = clearAppBadge;

		updateAppBadge(-1);

		expect(clearAppBadge).toHaveBeenCalledTimes(1);
		expect(setAppBadge).not.toHaveBeenCalled();
	});

	it("swallows a rejected badge promise", async () => {
		const nav = navigator as BadgeNav;
		nav.setAppBadge = vi.fn().mockRejectedValue(new Error("denied"));

		// Must not throw synchronously...
		expect(() => updateAppBadge(3)).not.toThrow();
		// ...and the rejection must be handled, not left unhandled.
		await Promise.resolve();
	});

	it("does nothing when the Badging API is unavailable", () => {
		// No setAppBadge/clearAppBadge on navigator (cleared in afterEach).
		expect(() => updateAppBadge(7)).not.toThrow();
		expect(() => updateAppBadge(0)).not.toThrow();
	});
});
