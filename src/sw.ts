/// <reference lib="WebWorker" />
import {
	cleanupOutdatedCaches,
	createHandlerBoundToURL,
	type PrecacheEntry,
	precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

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

// Deliberately do NOT skipWaiting()/clientsClaim(): a new worker stays in
// "waiting" until every tab is closed, so deploys never force-reload a live
// session (e.g. mid-call) and a running client keeps serving its matching
// hashed chunks from the still-active precache. Updates apply on the next cold
// start. Push delivery and subscription work without claiming the page.

// ─── Background Web Push ───

interface PushPayload {
	event_id?: string;
	room_id?: string;
	room_name?: string;
	room_alias?: string;
	sender?: string;
	sender_display_name?: string;
	type?: string;
	unread?: number;
	content?: { body?: string; msgtype?: string };
}

/** Describe an event's content for a notification, mirroring the in-app
 *  notification copy in useNotifications.ts. `isText` distinguishes a literal
 *  message body (joined to the sender with ": ") from an action phrase like
 *  "sent an image" (joined with a space). */
function describeContent(payload: PushPayload): {
	isText: boolean;
	text: string;
} {
	const content = payload.content;
	switch (content?.msgtype) {
		case "m.image":
			return { isText: false, text: "sent an image" };
		case "m.file":
			return { isText: false, text: "sent a file" };
		case "m.audio":
			return { isText: false, text: "sent an audio file" };
		case "m.video":
			return { isText: false, text: "sent a video" };
		default: {
			const body =
				typeof content?.body === "string" ? content.body.slice(0, 200) : "";
			// Encrypted rooms: the homeserver/Sygnal forward ciphertext only, so
			// no readable body is present — fall back to a generic label.
			return { isText: true, text: body || "New message" };
		}
	}
}

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
	if (!payload.event_id || !payload.room_id) return;

	// Crust shares its origin with other apps (e.g. Cinny at "/", the homeserver
	// at "/_matrix/"), so `includeUncontrolled` window clients can include
	// unrelated same-origin tabs. Only treat windows within this SW's scope
	// (the Crust base path) as "an app window".
	const windows = await sw.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
	// If a Crust window is open, the in-app notification path already handles
	// alerting; skip here to avoid duplicate notifications.
	if (windows.some(isAppWindow)) return;

	const sender = payload.sender_display_name || payload.sender || "Someone";
	const room = payload.room_name || payload.room_alias;
	const { isText, text } = describeContent(payload);
	const senderLine = isText ? `${sender}: ${text}` : `${sender} ${text}`;
	// In a named room/space, lead with the room and attribute the message to the
	// sender. In a DM (no distinct room name), the title is the sender, so the
	// body is just the message/action without repeating the sender.
	const inRoom = !!room && room !== sender;
	const title = inRoom ? (room as string) : sender;
	const body = inRoom ? senderLine : text;

	// `renotify` (re-alert when replacing a same-tag notification) is a valid
	// Notifications API option but missing from the current lib typings.
	const options: NotificationOptions & { renotify?: boolean } = {
		body,
		tag: payload.room_id,
		icon: `${import.meta.env.BASE_URL}pwa-192.png`,
		badge: `${import.meta.env.BASE_URL}pwa-192.png`,
		data: { roomId: payload.room_id },
		renotify: true,
	};
	await sw.registration.showNotification(title, options);
}

sw.addEventListener("push", (event) => {
	event.waitUntil(handlePush(event));
});

async function openRoom(roomId: string | undefined): Promise<void> {
	const url = roomId ? `${base}home/${encodeURIComponent(roomId)}` : base;
	const windows = await sw.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
	// Only reuse a window that belongs to Crust; never hijack an unrelated
	// same-origin tab (e.g. Cinny). Fall back to opening a new window.
	const appWindow = windows.find(isAppWindow);
	if (appWindow) {
		await appWindow.focus();
		if (roomId) {
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
