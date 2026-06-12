/**
 * OS/taskbar app-badge control for the foreground (window) context.
 *
 * The service worker also drives this badge from push payloads (see
 * `setBadge` in `src/sw.ts`), but that only fires when a push is delivered, so
 * the badge goes stale when unread state changes in-app — e.g. the user reads
 * a message and the count should drop. This module lets an open window keep the
 * badge in sync with live in-app unread state. Both writers target the same OS
 * badge; whoever wrote last wins, which is fine: while a window is open it
 * updates reactively and stays accurate, and the SW covers the closed-app case.
 *
 * The Badging API (`navigator.setAppBadge` / `clearAppBadge`) is only present
 * for installed PWAs on supporting browsers; calls are guarded and best-effort.
 */
function badgeNav(): {
	setAppBadge?: (n?: number) => Promise<void>;
	clearAppBadge?: () => Promise<void>;
} | null {
	if (typeof navigator === "undefined") return null;
	return navigator as Navigator & {
		setAppBadge?: (n?: number) => Promise<void>;
		clearAppBadge?: () => Promise<void>;
	};
}

/**
 * Set the app badge to `count`, clearing it when `count` is zero (or negative).
 * Mirrors the service worker's `setBadge`. Promise rejections are swallowed —
 * a failed badge update is never worth surfacing.
 */
export function updateAppBadge(count: number): void {
	const nav = badgeNav();
	if (!nav) return;
	if (count > 0) nav.setAppBadge?.(count).catch(() => {});
	else nav.clearAppBadge?.().catch(() => {});
}
