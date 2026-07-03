import { createSignal, onCleanup } from "solid-js";

/**
 * Coarse relative-time label for "last activity" style UI ("5m ago",
 * "3h ago", "2d ago", then a locale date). Shared by the device list and
 * the thread summary chip.
 */
export function formatRelativeTime(ts: number, now: number): string {
	const diffMs = Math.max(0, now - ts);
	const diffMins = Math.floor(diffMs / 60_000);
	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays < 7) return `${diffDays}d ago`;
	return new Date(ts).toLocaleDateString();
}

const TICK_MS = 60_000;
const [minuteTick, setMinuteTick] = createSignal(Date.now());
let tickSubscribers = 0;
let tickTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Shared minute ticker for relative-time labels: ONE interval no matter
 * how many components subscribe (a busy room can show dozens of chips),
 * stopped when the last subscriber unmounts. Call during component
 * setup; the returned accessor updates once a minute.
 */
export function useMinuteTick(): () => number {
	tickSubscribers++;
	if (tickSubscribers === 1) {
		setMinuteTick(Date.now());
		tickTimer = setInterval(() => setMinuteTick(Date.now()), TICK_MS);
	}
	onCleanup(() => {
		tickSubscribers--;
		if (tickSubscribers === 0 && tickTimer !== null) {
			clearInterval(tickTimer);
			tickTimer = null;
		}
	});
	return minuteTick;
}
