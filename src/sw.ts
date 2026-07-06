/// <reference lib="WebWorker" />
import {
	cleanupOutdatedCaches,
	createHandlerBoundToURL,
	type PrecacheEntry,
	precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import {
	buildNotificationCopy,
	type PushPayload,
	trimmedField,
} from "./features/notifications/pushCopy";
import { iconCacheUrls, isIconRequest } from "./lib/iconRuntimeCache";
import { NOTIFY_CHANNEL_NAME, type NotifyPong } from "./lib/notifyChannel";
import { staleWhileRevalidate } from "./lib/swrCache";

// `self` is typed as a generic WorkerGlobalScope by the WebWorker lib; narrow
// it to the service-worker scope so registration/clients are typed.
const sw = self as unknown as ServiceWorkerGlobalScope;

// ─── Precache the build output ───
// vite-plugin-pwa replaces `self.__WB_MANIFEST` with the list of hashed build
// assets at build time. config.json is excluded (see injectManifest.globIgnores
// in vite.config.ts) so runtime configuration is always fetched fresh.
const manifest = (
	self as unknown as { __WB_MANIFEST: (string | PrecacheEntry)[] }
).__WB_MANIFEST;
precacheAndRoute(manifest);
cleanupOutdatedCaches();

// SPA navigation fallback: serve the precached app shell for in-scope
// *navigation* requests (instant load, offline-capable). The SW's own scope
// (the base path, e.g. "/crust/") already limits which navigations the browser
// dispatches here, but we additionally constrain the fallback to an explicit
// base-path allowlist (defense-in-depth on a shared origin) and deny
// `config.json` (always fetched fresh) and `/_matrix/` (homeserver API).
const base = import.meta.env.BASE_URL;
const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const navigationHandler = createHandlerBoundToURL(`${base}index.html`);
registerRoute(
	new NavigationRoute(navigationHandler, {
		allowlist: [new RegExp(`^${escapedBase}`)],
		denylist: [/\/config\.json$/, /^\/_matrix\//],
	}),
);

// ─── Runtime cache for the stable-named PWA icons ───
// The app icons/favicon (pwa-*.png, apple-touch-icon.png, favicon.svg) are
// excluded from the precache (injectManifest.globIgnores in vite.config.ts) and
// served here instead. Because this SW never auto-skipWaiting()s (above), a
// *precached* icon would stay stale until the new worker fully took over. See
// issue #252.
const ICON_CACHE = "crust-icons";

// Warm the icon cache at install so the icons are available offline - roughly
// the availability the precache used to give (best-effort, see below).
// `{ cache: "reload" }` bypasses the HTTP cache so we store the freshly-deployed
// bytes. Warming also overwrites the shared ICON_CACHE eagerly, so once this
// feature is live a later icon-only deploy is picked up by the *currently active*
// worker's SWR route on the next load. (On the very first deploy that introduces
// this route the previous worker is the old precache-only SW with no icon route,
// so for that one transition a changed icon still waits for this worker to take
// over.) Best-effort: allSettled + try/catch means a transient offline install
// never fails the SW install (which would also block app-shell updates); the
// route below repopulates on the next successful fetch.
async function warmIconCache(): Promise<void> {
	try {
		const cache = await caches.open(ICON_CACHE);
		await Promise.allSettled(
			iconCacheUrls(base).map(async (url) => {
				const res = await fetch(url, { cache: "reload" });
				if (res.ok) await cache.put(url, res.clone());
			}),
		);
	} catch {
		// best-effort; nothing actionable if opening the cache throws
	}
}
sw.addEventListener("install", (event) => {
	event.waitUntil(warmIconCache());
});

// Serve the icons stale-while-revalidate: return the cached copy instantly (like
// the precache did) and refresh it in the background so a changed icon lands on
// the next load. `event.waitUntil` keeps the worker alive until the background
// refresh's cache write finishes (else an idle-worker termination would drop it
// and the icon would stay stale). Keyed by pathname (query dropped) so variant
// query strings can't grow the cache past one entry per icon.
//
// The revalidation fetch uses `{ cache: "reload" }` (like the install warm): the
// icons ship with a year-long max-age, so a default fetch would revalidate
// against the browser's HTTP cache and keep seeing the OLD bytes - never picking
// up a redeployed icon. reload bypasses the HTTP cache to hit the network.
//
// If CacheStorage itself is unavailable (restricted storage contexts), fall back
// to serving the icon directly rather than failing the request - still with
// `{ cache: "reload" }` so a redeployed icon stays visible in that degraded path
// (a default fetch would return the browser's year-old HTTP-cached bytes).
registerRoute(
	({ url }) => isIconRequest(url, base, sw.location.origin),
	async ({ request, event }) => {
		let cache: Cache;
		try {
			cache = await caches.open(ICON_CACHE);
		} catch {
			return fetch(request, { cache: "reload" });
		}
		return staleWhileRevalidate(
			cache,
			new URL(request.url).pathname,
			() => fetch(request, { cache: "reload" }),
			(background) => event.waitUntil(background),
		);
	},
);

// Deliberately do NOT skipWaiting()/clientsClaim() automatically: a new worker
// stays in "waiting" until every tab is closed, so deploys never force-reload a
// live session (e.g. mid-call) and a running client keeps serving its matching
// hashed chunks from the still-active precache. Updates apply on the next cold
// start. Push delivery and subscription work without claiming the page.
//
// The one exception is a strictly user-initiated update: the in-app
// "Update available" prompt (src/app/UpdatePrompt.tsx) messages the waiting
// worker via workbox-window's messageSkipWaiting (a {type:"SKIP_WAITING"}
// postMessage). Only then do we skipWaiting, after which workbox-window
// reloads the page on `controllerchange`. This never fires without an explicit
// click, so the "never auto-reload a live session" guarantee holds.
sw.addEventListener("message", (event) => {
	if ((event.data as { type?: string } | null)?.type !== "SKIP_WAITING") return;
	// Only honor the update trigger from a client within this SW's scope (a
	// Crust window), not an unrelated same-origin tab (e.g. Cinny at "/").
	// `event.source` is the posting client; the scope check mirrors isAppWindow
	// (`"url" in source` narrows out ServiceWorker/MessagePort, which lack it).
	const source = event.source;
	const inScope =
		!!source && "url" in source && source.url.startsWith(sw.registration.scope);
	if (!inScope) return;
	// skipWaiting() is async; keep the worker alive until it resolves so a
	// user-initiated update isn't dropped if the SW is terminated early.
	event.waitUntil(sw.skipWaiting());
});

// ─── Background Web Push ───

/** True when a window client belongs to this app, so unrelated same-origin
 *  tabs (e.g. Cinny at "/") don't suppress notifications or get hijacked on
 *  click. `registration.scope` is the app's full base URL with a trailing
 *  slash (e.g. "https://host/crust/"), which both scopes the match to Crust
 *  and avoids "/crust" matching a sibling "/crust-other". For a root-scoped
 *  deployment (base "/") the scope is the origin root and every same-origin
 *  tab matches — correct there, since a root-scoped SW already controls the
 *  whole origin (its navigation fallback serves Crust's shell for all
 *  same-origin navigations), so Crust effectively owns it. */
function isAppWindow(client: WindowClient): boolean {
	return client.url.startsWith(sw.registration.scope);
}

function setBadge(count: number): void {
	const nav = navigator as WorkerNavigator & {
		setAppBadge?: (n?: number) => Promise<void>;
		clearAppBadge?: () => Promise<void>;
	};
	if (count > 0) nav.setAppBadge?.(count).catch(() => {});
	else nav.clearAppBadge?.().catch(() => {});
}

// Max time to wait for an open client to confirm it will surface the event
// in-app before falling back to showing the background notification ourselves.
// Kept short so push handling stays snappy; biasing toward showing on timeout
// favours never-missing over the rare duplicate (same-tag notifications
// replace each other, so a duplicate is cheap).
const NOTIFY_PING_TIMEOUT_MS = 500;

/** Ask open app clients whether any of them will surface this specific event
 *  in-app. Returns true only if a live client replies `canNotify: true` for the
 *  given `eventId` within the timeout. An open tab that can't or won't surface
 *  *this* event — login page, suspended/discarded tab (its JS is frozen, so it
 *  never replies), desktop notifications disabled, or a bare-notify event the
 *  in-app path doesn't pop — does not suppress the background notification,
 *  closing the silent-drop gap. Fail-open: any error (e.g. BroadcastChannel
 *  construction failing in a restricted environment) resolves `false` so the
 *  background notification still shows rather than being silently dropped. */
function aClientWillNotify(eventId: string): Promise<boolean> {
	if (typeof BroadcastChannel === "undefined") return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		let channel: BroadcastChannel | undefined;
		let nonce: string;
		try {
			channel = new BroadcastChannel(NOTIFY_CHANNEL_NAME);
			nonce = crypto.randomUUID();
		} catch {
			// If the channel was constructed before the throw, close it so it
			// doesn't leak; then fail open.
			try {
				channel?.close();
			} catch {
				// best-effort
			}
			resolve(false);
			return;
		}
		let timer: ReturnType<typeof setTimeout>;
		let settled = false;
		const finish = (result: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				channel.close();
			} catch {
				// best-effort; nothing actionable if close() throws
			}
			resolve(result);
		};
		channel.onmessage = (e: MessageEvent) => {
			const data = e.data as NotifyPong | null;
			if (
				data?.type === "pong" &&
				data.nonce === nonce &&
				data.canNotify === true
			) {
				finish(true);
			}
		};
		timer = setTimeout(() => finish(false), NOTIFY_PING_TIMEOUT_MS);
		try {
			channel.postMessage({ type: "ping", nonce, eventId });
		} catch {
			// Couldn't ask any client — fall back to showing the notification.
			finish(false);
		}
	});
}

async function handlePush(event: PushEvent): Promise<void> {
	if (!event.data) return;
	let payload: PushPayload;
	try {
		payload = event.data.json() as PushPayload;
	} catch {
		return;
	}
	// `event.data.json()` happily parses a literal `null` (or a non-object),
	// which would throw on the property access below — guard before use.
	if (typeof payload !== "object" || payload === null) return;

	if (typeof payload.unread === "number") setBadge(payload.unread);

	// Counts-only pushes (e.g. badge clears) carry no event_id. The pusher is
	// registered with events_only so Sygnal drops these before delivery, but
	// guard anyway so the browser never shows an empty "updated in background".
	// The payload is user-influenced JSON: `trimmedField` requires each id to
	// be a non-empty, non-whitespace string before it flows into the
	// notification tag / click route (also drops non-string values).
	const roomId = trimmedField(payload.room_id);
	const eventId = trimmedField(payload.event_id);
	if (roomId === "" || eventId === "") return;

	// Crust shares its origin with other apps (e.g. Cinny at "/", the homeserver
	// at "/_matrix/"), so `includeUncontrolled` window clients can include
	// unrelated same-origin tabs. Only treat windows within this SW's scope
	// (the Crust base path) as "an app window".
	const windows = await sw.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
	// If a Crust window is open AND a live client confirms it will surface this
	// specific event in-app, skip here to avoid a duplicate. A client only
	// confirms when it is synced and either focused (user sees it live) or it
	// popped a desktop notification for this event; an open-but-incapable tab
	// (login page, suspended/discarded tab, desktop notifications disabled) or a
	// bare-notify event the in-app path doesn't pop won't confirm, so the
	// background notification still shows. See useNotifications.ts.
	if (windows.some(isAppWindow) && (await aClientWillNotify(eventId))) return;

	// Trim user-controlled room/sender names so whitespace-only values don't
	// produce blank notification titles (matches the in-app path in
	// useNotifications.ts). buildNotificationCopy resolves the title/body,
	// including the encrypted-room and DM cases. See pushCopy.ts.
	const { title, body } = buildNotificationCopy(payload);

	// `renotify` (re-alert when replacing a same-tag notification) is a valid
	// Notifications API option but missing from the current lib typings.
	const options: NotificationOptions & { renotify?: boolean } = {
		body,
		tag: roomId,
		icon: `${import.meta.env.BASE_URL}pwa-192.png`,
		badge: `${import.meta.env.BASE_URL}pwa-192.png`,
		data: { roomId },
		renotify: true,
	};
	await sw.registration.showNotification(title, options);
}

sw.addEventListener("push", (event) => {
	event.waitUntil(handlePush(event));
});

/** Build the in-app deep link for a room, falling back to the app root if the
 *  roomId can't be encoded (e.g. a malformed string with a lone surrogate,
 *  which would make encodeURIComponent throw URIError).
 *
 *  Always uses the `/home/` route: the push payload carries no is-DM hint and
 *  the worker has no SDK/m.direct access, so it can't pick `/dm/` here. The app
 *  canonicalizes `/home/<dmId>` to `/dm/<dmId>` after load once summaries know
 *  the room is direct (see the createEffect in src/app/Layout.tsx). */
function roomUrl(roomId: string | undefined): string {
	if (!roomId) return base;
	try {
		return `${base}home/${encodeURIComponent(roomId)}`;
	} catch {
		return base;
	}
}

async function openRoom(roomId: string | undefined): Promise<void> {
	const url = roomUrl(roomId);
	const hasTarget = url !== base;
	const windows = await sw.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
	// Only reuse a window that belongs to Crust; never hijack an unrelated
	// same-origin tab (e.g. Cinny). Fall back to opening a new window.
	const appWindow = windows.find(isAppWindow);
	if (appWindow) {
		await appWindow.focus();
		if (hasTarget) {
			try {
				await appWindow.navigate(url);
			} catch {
				// Navigation can reject if the client is mid-unload; focusing is
				// enough in that case.
			}
		}
		return;
	}
	await sw.clients.openWindow(url);
}

sw.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const data = event.notification.data as { roomId?: string } | null;
	event.waitUntil(openRoom(data?.roomId));
});
