import { afterEach, describe, expect, it, vi } from "vitest";
import { updateAppBadge } from "./appBadge";

const BADGE_METHODS = ["setAppBadge", "clearAppBadge"] as const;
type BadgeMethod = (typeof BADGE_METHODS)[number];

/**
 * Install a stub Badging API method as a *configurable own* property on
 * `navigator`, so afterEach can delete it to fully restore the original state —
 * revealing any prototype-provided implementation rather than leaving a stale
 * own property behind (jsdom doesn't implement these methods, but a browser
 * test env might). Returns the spy for assertions.
 */
function stubBadge(
	name: BadgeMethod,
	reject = false,
): ReturnType<typeof vi.fn> {
	const spy = reject
		? vi.fn().mockRejectedValue(new Error("denied"))
		: vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, name, {
		value: spy,
		configurable: true,
		writable: true,
	});
	return spy;
}

afterEach(() => {
	for (const name of BADGE_METHODS) {
		if (Object.hasOwn(navigator, name)) {
			delete (navigator as unknown as Record<string, unknown>)[name];
		}
	}
	vi.restoreAllMocks();
});

describe("updateAppBadge", () => {
	it("sets the badge to the count when positive", () => {
		const setAppBadge = stubBadge("setAppBadge");
		const clearAppBadge = stubBadge("clearAppBadge");

		updateAppBadge(5);

		expect(setAppBadge).toHaveBeenCalledWith(5);
		expect(clearAppBadge).not.toHaveBeenCalled();
	});

	it("clears the badge when the count is zero", () => {
		const setAppBadge = stubBadge("setAppBadge");
		const clearAppBadge = stubBadge("clearAppBadge");

		updateAppBadge(0);

		expect(clearAppBadge).toHaveBeenCalledTimes(1);
		expect(setAppBadge).not.toHaveBeenCalled();
	});

	it("clears the badge for a negative count rather than setting it", () => {
		const setAppBadge = stubBadge("setAppBadge");
		const clearAppBadge = stubBadge("clearAppBadge");

		updateAppBadge(-1);

		expect(clearAppBadge).toHaveBeenCalledTimes(1);
		expect(setAppBadge).not.toHaveBeenCalled();
	});

	it("swallows a rejected badge promise", async () => {
		stubBadge("setAppBadge", true);

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
