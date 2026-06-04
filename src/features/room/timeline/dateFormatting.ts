/**
 * Date-formatting helpers for the timeline.
 *
 * These deliberately compare local-calendar fields (year / month /
 * date) rather than subtracting elapsed milliseconds: across DST
 * boundaries the elapsed-ms approach can land "yesterday" on the wrong
 * calendar day, and we want all of these comparisons to track the
 * user's wall clock.
 */

import { createSignal, onCleanup } from "solid-js";

export function isSameDay(ts1: number, ts2: number): boolean {
	const d1 = new Date(ts1);
	const d2 = new Date(ts2);
	return (
		d1.getFullYear() === d2.getFullYear() &&
		d1.getMonth() === d2.getMonth() &&
		d1.getDate() === d2.getDate()
	);
}

export function isDifferentDay(ts1: number, ts2: number): boolean {
	return !isSameDay(ts1, ts2);
}

// Cache Intl.DateTimeFormat instances. Construction is the dominant
// cost; formatting against a cached instance is near-free. Keyed by
// the option-set we use; the user's locale is read once via
// `undefined` and reflects the browser default.
const longDateFmt = new Intl.DateTimeFormat(undefined, {
	weekday: "long",
	year: "numeric",
	month: "long",
	day: "numeric",
});

const fullDate12hFmt = new Intl.DateTimeFormat(undefined, {
	year: "numeric",
	month: "long",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hour12: true,
});

const fullDate24hFmt = new Intl.DateTimeFormat(undefined, {
	year: "numeric",
	month: "long",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
});

/**
 * Returns "Today", "Yesterday", or a localized long date label
 * (e.g. "Monday, May 25, 2026") for everything older. The `now`
 * parameter exists for deterministic testing; in production callers
 * pass the default.
 */
export function formatDateSeparatorLabel(
	ts: number,
	now: number = Date.now(),
): string {
	if (isSameDay(ts, now)) return "Today";
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (isSameDay(ts, yesterday.getTime())) return "Yesterday";
	return longDateFmt.format(new Date(ts));
}

/**
 * Full localized date + time string for hover tooltips, honoring the
 * user's 12h/24h preference.
 */
export function formatFullDateTime(
	ts: number,
	timeFormat: "12h" | "24h",
): string {
	const fmt = timeFormat === "12h" ? fullDate12hFmt : fullDate24hFmt;
	return fmt.format(new Date(ts));
}

/**
 * Returns milliseconds from `from` to the next local midnight (start of
 * the next calendar day in the user's timezone). Always > 0.
 */
export function msUntilNextLocalMidnight(from: number = Date.now()): number {
	const d = new Date(from);
	const next = new Date(
		d.getFullYear(),
		d.getMonth(),
		d.getDate() + 1,
		0,
		0,
		0,
		0,
	);
	return Math.max(1, next.getTime() - from);
}

/**
 * Reactive "now" accessor that updates at each local midnight, so
 * separator labels like "Today" / "Yesterday" automatically refresh
 * for sessions left open across a day boundary. Must be used inside
 * a Solid reactive scope (component or root).
 */
export function useDayTick(): () => number {
	const [now, setNow] = createSignal(Date.now());
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = (): void => {
		timer = setTimeout(() => {
			setNow(Date.now());
			schedule();
		}, msUntilNextLocalMidnight());
	};
	schedule();
	onCleanup(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
	return now;
}
