import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	formatRelativeTime,
	useMinuteTick,
	useThirtySecondTick,
} from "./relativeTime";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Fixed "now" so cases are deterministic (no Date.now() in the assertions).
const NOW = 1_700_000_000_000;

describe("formatRelativeTime", () => {
	it("shows 'just now' under a minute", () => {
		expect(formatRelativeTime(NOW, NOW)).toBe("just now");
		expect(formatRelativeTime(NOW - 30_000, NOW)).toBe("just now");
		expect(formatRelativeTime(NOW - (MIN - 1), NOW)).toBe("just now");
	});

	it("shows minutes from 1 to 59", () => {
		expect(formatRelativeTime(NOW - MIN, NOW)).toBe("1m ago");
		expect(formatRelativeTime(NOW - 5 * MIN, NOW)).toBe("5m ago");
		expect(formatRelativeTime(NOW - 59 * MIN, NOW)).toBe("59m ago");
	});

	it("shows hours from 1 to 23", () => {
		expect(formatRelativeTime(NOW - HOUR, NOW)).toBe("1h ago");
		expect(formatRelativeTime(NOW - 3 * HOUR, NOW)).toBe("3h ago");
		expect(formatRelativeTime(NOW - 23 * HOUR, NOW)).toBe("23h ago");
	});

	it("shows days from 1 to 6", () => {
		expect(formatRelativeTime(NOW - DAY, NOW)).toBe("1d ago");
		expect(formatRelativeTime(NOW - 6 * DAY, NOW)).toBe("6d ago");
	});

	it("falls back to a locale date at 7 days and beyond", () => {
		const ts = NOW - 7 * DAY;
		expect(formatRelativeTime(ts, NOW)).toBe(new Date(ts).toLocaleDateString());
	});

	it("clamps future timestamps to 'just now'", () => {
		expect(formatRelativeTime(NOW + 10 * MIN, NOW)).toBe("just now");
	});

	it("rolls over cleanly at unit boundaries", () => {
		expect(formatRelativeTime(NOW - 60 * MIN, NOW)).toBe("1h ago");
		expect(formatRelativeTime(NOW - 24 * HOUR, NOW)).toBe("1d ago");
	});
});

describe("useMinuteTick", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		// Order matters: restore the setInterval/clearInterval spies FIRST (their
		// captured "original" is the fake-timer function), THEN swap fake timers
		// back for real ones - so globalThis ends up with the real timers, not an
		// orphaned fake. (The unit project has no global restoreMocks.)
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("shares one interval across subscribers and clears it after the last unsubscribes", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

		let disposeA!: () => void;
		let disposeB!: () => void;
		let tick!: () => number;

		// useMinuteTick keys off module-global subscriber state, so every test
		// must leave that state at zero. Dispose in `finally` (idempotent) so an
		// assertion failure can't leak a subscriber into the next test.
		try {
			createRoot((dispose) => {
				disposeA = dispose;
				tick = useMinuteTick();
			});
			// A second subscriber must NOT start its own interval.
			createRoot((dispose) => {
				disposeB = dispose;
				useMinuteTick();
			});
			expect(setIntervalSpy).toHaveBeenCalledTimes(1);

			// The shared accessor advances once a minute.
			const before = tick();
			vi.advanceTimersByTime(60_000);
			expect(tick()).toBeGreaterThan(before);

			// Dropping one subscriber keeps the interval alive for the other.
			disposeA();
			expect(clearIntervalSpy).not.toHaveBeenCalled();

			// The last unsubscribe stops the interval.
			disposeB();
			expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
		} finally {
			disposeA?.();
			disposeB?.();
		}
	});

	it("restarts a fresh interval after all subscribers have left", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		createRoot((dispose) => {
			useMinuteTick();
			dispose();
		});
		createRoot((dispose) => {
			useMinuteTick();
			dispose();
		});
		// Each subscribe-from-zero starts exactly one interval (the first
		// subscriber of each cycle), so two full cycles => two setInterval calls.
		expect(setIntervalSpy).toHaveBeenCalledTimes(2);
	});
});

describe("useThirtySecondTick", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		// Same restore-order rule as the minute-tick suite: spies first,
		// then real timers, so globalThis never keeps an orphaned fake.
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("shares one interval across subscribers and clears it after the last unsubscribes", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

		let disposeA!: () => void;
		let disposeB!: () => void;
		let tick!: () => number;

		// Module-global subscriber state: dispose in `finally` (idempotent)
		// so a failed assertion can't leak a subscriber into the next test.
		try {
			createRoot((dispose) => {
				disposeA = dispose;
				tick = useThirtySecondTick();
			});
			// A second subscriber must NOT start its own interval.
			createRoot((dispose) => {
				disposeB = dispose;
				useThirtySecondTick();
			});
			expect(setIntervalSpy).toHaveBeenCalledTimes(1);

			// The shared accessor advances on the 30s cadence.
			const before = tick();
			vi.advanceTimersByTime(30_000);
			expect(tick()).toBeGreaterThan(before);

			// Dropping one subscriber keeps the interval alive for the other.
			disposeA();
			expect(clearIntervalSpy).not.toHaveBeenCalled();

			// The last unsubscribe stops the interval.
			disposeB();
			expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
		} finally {
			disposeA?.();
			disposeB?.();
		}
	});

	it("restarts a fresh interval after all subscribers have left", () => {
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		createRoot((dispose) => {
			useThirtySecondTick();
			dispose();
		});
		createRoot((dispose) => {
			useThirtySecondTick();
			dispose();
		});
		expect(setIntervalSpy).toHaveBeenCalledTimes(2);
	});
});
