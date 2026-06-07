/// <reference lib="WebWorker" />
import {
	cleanupOutdatedCaches,
	createHandlerBoundToURL,
	type PrecacheEntry,
	precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import {
	NOTIFY_CHANNEL_NAME,
	type NotifyPong,
} from "./features/notifications/notifyChannel";

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

/** Trim a push-payload field, tolerating non-string values: the payload is
 *  user-influenced JSON typed only by assertion, so a non-string (number,
 *  object, …) must not reach `.trim()` (which would throw). */
function trimmedField(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
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

/** Ask open app clients whether any of them will surface this event in-app.
 *  Returns true only if a live client replies `canNotify: true` within the
 *  timeout. An open tab that can't notify — login page, suspended/discarded
 *  tab (its JS is frozen, so it never replies), or one with desktop
 *  notifications disabled — does not suppress the background notification,
 *  closing the silent-drop gap. Fail-open: any error (e.g. BroadcastChannel
 *  construction failing in a restricted environment) resolves `false` so the
 *  background notification still shows rather than being silently dropped. */
function aClientWillNotify(): Promise<boolean> {
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
			channel.postMessage({ type: "ping", nonce });
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
	if (roomId === "" || trimmedField(payload.event_id) === "") return;

	// Crust shares its origin with other apps (e.g. Cinny at "/", the homeserver
	// at "/_matrix/"), so `includeUncontrolled` window clients can include
	// unrelated same-origin tabs. Only treat windows within this SW's scope
	// (the Crust base path) as "an app window".
	const windows = await sw.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
	// If a Crust window is open AND a live client confirms it will surface this
	// event in-app, skip here to avoid a duplicate. A client only confirms when
	// it is synced and either focused (user sees it live) or able to show a
	// desktop notification; an open-but-incapable tab (login page, suspended/
	// discarded tab, or desktop notifications disabled) won't confirm, so the
	// background notification still shows. See useNotifications.ts.
	if (windows.some(isAppWindow) && (await aClientWillNotify())) return;

	// Trim user-controlled room/sender names so whitespace-only values don't
	// produce blank notification titles (matches the in-app path in
	// useNotifications.ts, which trims room/member names). `trimmedField`
	// tolerates non-string payload values.
	const sender =
		trimmedField(payload.sender_display_name) ||
		trimmedField(payload.sender) ||
		"Someone";
	const room =
		trimmedField(payload.room_name) || trimmedField(payload.room_alias);
	const { isText, text } = describeContent(payload);
	const senderLine = isText ? `${sender}: ${text}` : `${sender} ${text}`;
	// In a named room/space, lead with the room and attribute the message to the
	// sender. In a DM (no distinct room name), the title is the sender, so the
	// body is just the message/action without repeating the sender.
	const inRoom = room !== "" && room !== sender;
	const title = inRoom ? room : sender;
	const body = inRoom ? senderLine : text;

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
