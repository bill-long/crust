/**
 * Coarse relative-time label for "last activity" style UI ("5m ago",
 * "3h ago", "2d ago", then a locale date). Shared by the device list and
 * the thread summary chip; dependency-free.
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
