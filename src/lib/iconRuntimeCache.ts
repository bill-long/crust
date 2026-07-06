/**
 * The stable-named PWA icon/favicon assets that the service worker serves from a
 * runtime cache instead of precaching (issue #252).
 *
 * The service worker deliberately never `skipWaiting()`s on deploy so a live
 * session is never force-reloaded (see src/sw.ts). A consequence is that a
 * *precached* asset with a stable filename stays stale until the new worker
 * fully takes over - so an icon or favicon change stays invisible to existing
 * users long after it ships. Serving these off a runtime cache instead lets a
 * changed icon propagate promptly, while warming that cache at install keeps the
 * offline availability the precache used to provide.
 *
 * These filenames are stable across deploys (the app shell is hashed; icons are
 * not), so the runtime cache holds at most one entry per icon.
 *
 * This is the single source of truth for the icon set: `vite.config.ts` derives
 * both the precache `globIgnores` and a manifest-icon coverage assertion from
 * it, so the precache exclusion can't drift from what the runtime route caches.
 */
export const ICON_FILENAMES = [
	"pwa-192.png",
	"pwa-512.png",
	"pwa-maskable-512.png",
	"apple-touch-icon.png",
	"favicon.svg",
] as const;

/**
 * The in-scope URLs (paths) of this deployment's icon assets, e.g.
 * `/crust/pwa-192.png` under base `/crust/`. Used to warm the runtime cache at
 * install so the icons are available offline immediately.
 */
export function iconCacheUrls(base: string): string[] {
	return ICON_FILENAMES.map((name) => `${base}${name}`);
}

/**
 * True when `url` is one of this deployment's stable-named icon assets: a
 * same-origin request whose path is `${base}<icon filename>` (e.g.
 * `/crust/pwa-192.png` under base `/crust/`). Used as the service worker's
 * runtime-cache route matcher.
 */
export function isIconRequest(url: URL, base: string, origin: string): boolean {
	if (url.origin !== origin) return false;
	return (ICON_FILENAMES as readonly string[]).some(
		(name) => url.pathname === `${base}${name}`,
	);
}
