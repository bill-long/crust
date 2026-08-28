import { isAccountScopeFrozen } from "../stores/session";

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

function writeBadge(count: number): void {
	const nav = badgeNav();
	if (!nav) return;
	if (count > 0) nav.setAppBadge?.(count).catch(() => {});
	else nav.clearAppBadge?.().catch(() => {});
}

/**
 * Set the app badge to `count`, clearing it when `count` is zero (or negative).
 * Mirrors the service worker's `setBadge`. Promise rejections are swallowed —
 * a failed badge update is never worth surfacing.
 *
 * Silent once an account switch has committed. `location.assign` only STARTS
 * the navigation (#533), so this document keeps syncing the OUTGOING account
 * until it is replaced - and the badge is one number for the whole install, now
 * owed to the incoming account. The scope freeze is exactly that signal, and
 * honoring it is what keeps {@link releaseAppBadge}'s clear cleared instead of
 * having the next sync update or tab focus put the old count straight back.
 */
export function updateAppBadge(count: number): void {
	if (isAccountScopeFrozen()) return;
	writeBadge(count);
}

/**
 * Clear the badge for an account this document is leaving, so the account it
 * leaves for never inherits an unread count that was never its own (#534). The
 * incoming account's first sync sets the real number (see `client/client.tsx`).
 *
 * Unconditional, unlike {@link updateAppBadge}: on the switch path the freeze
 * that silences ordinary writes is already set by the time this runs, and
 * silencing the clear too would leave exactly the count it exists to remove.
 */
export function releaseAppBadge(): void {
	writeBadge(0);
}
