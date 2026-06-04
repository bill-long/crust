import { describe, expect, it } from "vitest";
import {
	formatDateSeparatorLabel,
	formatFullDateTime,
	isDifferentDay,
	isSameDay,
	msUntilNextLocalMidnight,
} from "./dateFormatting";

// Use local-time constructors throughout so the assertions track the
// test runner's clock without UTC-vs-local skew.
const at = (y: number, m: number, d: number, h = 12, min = 0): number =>
	new Date(y, m, d, h, min).getTime();

describe("isSameDay / isDifferentDay", () => {
	it("treats same local date as same day", () => {
		expect(isSameDay(at(2026, 4, 25, 0, 0), at(2026, 4, 25, 23, 59))).toBe(
			true,
		);
		expect(isDifferentDay(at(2026, 4, 25, 0, 0), at(2026, 4, 25, 23, 59))).toBe(
			false,
		);
	});

	it("treats consecutive days as different", () => {
		expect(isSameDay(at(2026, 4, 25, 23, 59), at(2026, 4, 26, 0, 1))).toBe(
			false,
		);
		expect(isDifferentDay(at(2026, 4, 25, 23, 59), at(2026, 4, 26, 0, 1))).toBe(
			true,
		);
	});

	it("treats same date in different years as different days", () => {
		expect(isSameDay(at(2025, 4, 25), at(2026, 4, 25))).toBe(false);
	});

	it("treats same day-of-month in different months as different days", () => {
		expect(isSameDay(at(2026, 3, 25), at(2026, 4, 25))).toBe(false);
	});
});

describe("formatDateSeparatorLabel", () => {
	const now = at(2026, 4, 25, 13, 0); // Mon May 25 2026, 1pm local

	it("returns 'Today' for messages earlier the same day", () => {
		expect(formatDateSeparatorLabel(at(2026, 4, 25, 0, 1), now)).toBe("Today");
		expect(formatDateSeparatorLabel(at(2026, 4, 25, 12, 59), now)).toBe(
			"Today",
		);
	});

	it("returns 'Yesterday' for the previous calendar day", () => {
		expect(formatDateSeparatorLabel(at(2026, 4, 24, 23, 59), now)).toBe(
			"Yesterday",
		);
		expect(formatDateSeparatorLabel(at(2026, 4, 24, 0, 0), now)).toBe(
			"Yesterday",
		);
	});

	it("returns a localized full date for older days", () => {
		const ts = at(2026, 4, 23, 10, 0);
		// Compare against the same Intl call to stay locale-stable across
		// test environments.
		const expected = new Intl.DateTimeFormat(undefined, {
			weekday: "long",
			year: "numeric",
			month: "long",
			day: "numeric",
		}).format(new Date(ts));
		expect(formatDateSeparatorLabel(ts, now)).toBe(expected);
	});

	it("handles month boundary correctly (Yesterday = last day of prior month)", () => {
		const nowJune1 = at(2026, 5, 1, 9, 0);
		expect(formatDateSeparatorLabel(at(2026, 4, 31, 22, 0), nowJune1)).toBe(
			"Yesterday",
		);
	});

	it("handles year boundary correctly (Yesterday = Dec 31)", () => {
		const nowJan1 = at(2027, 0, 1, 9, 0);
		expect(formatDateSeparatorLabel(at(2026, 11, 31, 22, 0), nowJan1)).toBe(
			"Yesterday",
		);
	});
});

describe("formatFullDateTime", () => {
	const ts = at(2026, 4, 25, 13, 42);

	it("honors 12h preference", () => {
		const expected = new Intl.DateTimeFormat(undefined, {
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: true,
		}).format(new Date(ts));
		expect(formatFullDateTime(ts, "12h")).toBe(expected);
	});

	it("honors 24h preference", () => {
		const expected = new Intl.DateTimeFormat(undefined, {
			year: "numeric",
			month: "long",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).format(new Date(ts));
		expect(formatFullDateTime(ts, "24h")).toBe(expected);
	});

	it("12h and 24h differ in hour rendering", () => {
		// Same instant, opposite hour12 flag must produce different output for
		// a 13:xx local timestamp. Robust to any locale's digit set.
		expect(formatFullDateTime(ts, "12h")).not.toBe(
			formatFullDateTime(ts, "24h"),
		);
	});
});

describe("msUntilNextLocalMidnight", () => {
	it("returns the gap between `from` and the start of the next local day", () => {
		const noon = at(2026, 4, 25, 12, 0);
		const nextMidnight = new Date(2026, 4, 26, 0, 0, 0, 0).getTime();
		expect(msUntilNextLocalMidnight(noon)).toBe(nextMidnight - noon);
	});

	it("returns the full local-day length when called at the start of a local day", () => {
		// Compute the expected gap from the next-day constructor rather than
		// hardcoding 24h: on DST transition days a local day can be 23h or
		// 25h long, and the implementation deliberately follows local-calendar
		// boundaries.
		const startOfDay = new Date(2026, 4, 25, 0, 0, 0, 0).getTime();
		const nextMidnight = new Date(2026, 4, 26, 0, 0, 0, 0).getTime();
		expect(msUntilNextLocalMidnight(startOfDay)).toBe(
			nextMidnight - startOfDay,
		);
	});

	it("always returns a strictly positive value", () => {
		const justBeforeMidnight = new Date(2026, 4, 25, 23, 59, 59, 999).getTime();
		expect(msUntilNextLocalMidnight(justBeforeMidnight)).toBeGreaterThan(0);
	});

	it("crosses month boundary correctly", () => {
		const lastDay = at(2026, 4, 31, 23, 0);
		const nextDay = new Date(2026, 5, 1, 0, 0, 0, 0).getTime();
		expect(msUntilNextLocalMidnight(lastDay)).toBe(nextDay - lastDay);
	});

	it("crosses year boundary correctly", () => {
		const lastDay = at(2026, 11, 31, 23, 0);
		const nextDay = new Date(2027, 0, 1, 0, 0, 0, 0).getTime();
		expect(msUntilNextLocalMidnight(lastDay)).toBe(nextDay - lastDay);
	});
});
