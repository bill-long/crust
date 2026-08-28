import { afterEach, describe, expect, it, vi } from "vitest";
import { freezeAccountScope, unfreezeAccountScope } from "../stores/session";
import { releaseAppBadge, updateAppBadge } from "./appBadge";

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
	unfreezeAccountScope();
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

describe("an account this document is leaving", () => {
	it("stops writing counts once the switch has committed", () => {
		// `location.assign` only STARTS the navigation, so this document keeps
		// syncing the OUTGOING account until it is replaced. Its counts are no
		// longer the install's - and they would land right back on top of the
		// clear below.
		const setAppBadge = stubBadge("setAppBadge");
		freezeAccountScope();

		updateAppBadge(7);

		expect(setAppBadge).not.toHaveBeenCalled();
	});

	it("clears the badge even then", () => {
		// The clear is the whole point of the freeze; silencing it too would
		// leave exactly the count it exists to remove.
		const clearAppBadge = stubBadge("clearAppBadge");
		freezeAccountScope();

		releaseAppBadge();

		expect(clearAppBadge).toHaveBeenCalledOnce();
	});

	it("writes counts again for a switch that fell through", () => {
		// The pointer write failed, so this document goes on running the account
		// it tried to leave and owns the badge again.
		const setAppBadge = stubBadge("setAppBadge");
		freezeAccountScope();
		unfreezeAccountScope();

		updateAppBadge(7);

		expect(setAppBadge).toHaveBeenCalledWith(7);
	});
});
