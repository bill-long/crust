import type { IPusher, IPusherRequest, MatrixClient } from "matrix-js-sdk";
import { isPushConfigured, type PushConfig } from "../../types/config";

/** Web Push fields Sygnal's webpush pushkin reads from the pusher `data`.
 *  matrix-js-sdk types `data` narrowly ({ url, format, brand }); these extra
 *  fields pass through verbatim to `POST /_matrix/client/v3/pushers/set`. */
interface WebPushPusherData {
	url: string;
	endpoint: string;
	auth: string;
	events_only: boolean;
	only_last_per_room: boolean;
}

const SW_READY_TIMEOUT_MS = 10_000;

/** True when the browser exposes the APIs needed for background Web Push. */
export function isPushSupported(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof navigator !== "undefined" &&
		"serviceWorker" in navigator &&
		"PushManager" in window &&
		"Notification" in window
	);
}

/** Decode an unpadded URL-safe base64 VAPID key to the byte array the
 *  Push API expects for `applicationServerKey`. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
	const padding = "=".repeat((4 - (base64.length % 4)) % 4);
	const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(normalized);
	const buffer = new ArrayBuffer(raw.length);
	const out = new Uint8Array(buffer);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out;
}

function bytesEqual(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
	if (!a) return false;
	const view = new Uint8Array(a);
	if (view.length !== b.length) return false;
	for (let i = 0; i < view.length; i++) {
		if (view[i] !== b[i]) return false;
	}
	return true;
}

/** Resolve the active service-worker registration, rejecting if none becomes
 *  ready within the timeout (e.g. in dev, where the SW is disabled). */
async function getReadyRegistration(): Promise<ServiceWorkerRegistration> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error("Service worker is not available")),
			SW_READY_TIMEOUT_MS,
		);
	});
	try {
		return await Promise.race([navigator.serviceWorker.ready, timeout]);
	} finally {
		// Clear the timer once the race settles so it doesn't dangle for the
		// full timeout after `ready` has already won.
		clearTimeout(timer);
	}
}

function buildPusher(cfg: PushConfig, sub: PushSubscription): IPusherRequest {
	const json = sub.toJSON();
	const p256dh = json.keys?.p256dh;
	const auth = json.keys?.auth;
	if (!p256dh || !auth) {
		throw new Error("Push subscription is missing encryption keys");
	}
	const data: WebPushPusherData = {
		url: cfg.gatewayUrl,
		endpoint: sub.endpoint,
		auth,
		// Drop counts-only pushes (no event_id) at the gateway, avoiding the
		// browser's forced "site updated in background" notification.
		events_only: true,
		// Collapse undelivered notifications per room via the WebPush Topic
		// header, reducing notification storms after the app is reopened.
		only_last_per_room: true,
	};
	return {
		kind: "http",
		app_id: cfg.appId,
		app_display_name: "Crust",
		device_display_name:
			typeof navigator !== "undefined"
				? navigator.userAgent.slice(0, 80)
				: "Crust Web",
		// Sygnal's webpush pushkin reads the p256dh key from `pushkey`.
		pushkey: p256dh,
		lang: navigator.language || "en",
		data: data as unknown as IPusher["data"],
		append: false,
	};
}

/**
 * Subscribe the browser to Web Push and register the resulting pusher with the
 * homeserver. Prompts for notification permission if not yet granted. Safe to
 * call repeatedly — it refreshes the pusher, re-subscribing if the existing
 * subscription was created with a different VAPID key.
 */
export async function enableWebPush(
	client: MatrixClient,
	cfg: PushConfig,
): Promise<void> {
	if (!isPushSupported()) {
		throw new Error("Push notifications are not supported in this browser");
	}
	if (!isPushConfigured(cfg)) {
		throw new Error("Push notifications are not configured by this server");
	}
	// Validate the operator gateway URL up front: a malformed value would
	// otherwise "succeed" locally and only fail later at delivery time.
	let gatewayUrl: URL;
	try {
		gatewayUrl = new URL(cfg.gatewayUrl);
	} catch {
		throw new Error(
			"Push notifications are misconfigured (invalid gateway URL)",
		);
	}
	if (gatewayUrl.protocol !== "https:" && gatewayUrl.protocol !== "http:") {
		throw new Error(
			"Push notifications are misconfigured (invalid gateway URL)",
		);
	}

	const permission = await Notification.requestPermission();
	if (permission !== "granted") {
		throw new Error("Notification permission was not granted");
	}

	const registration = await getReadyRegistration();
	let appServerKey: Uint8Array<ArrayBuffer>;
	try {
		appServerKey = urlBase64ToUint8Array(cfg.vapidPublicKey);
	} catch {
		// `cfg.vapidPublicKey` comes from operator config.json; a malformed /
		// mis-padded base64 value makes atob throw a cryptic DOMException.
		// Surface a clear, actionable message instead.
		throw new Error(
			"Push notifications are misconfigured (invalid VAPID public key)",
		);
	}
	// A VAPID application server key is the 65-byte uncompressed P-256 point
	// (0x04 || X || Y). A well-formed-base64 value of the wrong shape decodes
	// fine but would fail with a cryptic subscribe() DOMException downstream —
	// reject it here with the same clear message.
	if (appServerKey.length !== 65 || appServerKey[0] !== 0x04) {
		throw new Error(
			"Push notifications are misconfigured (invalid VAPID public key)",
		);
	}

	let sub = await registration.pushManager.getSubscription();
	if (sub) {
		const existingKey = sub.options.applicationServerKey;
		if (!bytesEqual(existingKey, appServerKey)) {
			// VAPID key changed (or unknown) — the old subscription can't be
			// reused; drop it and create a fresh one.
			// Remove the stale pusher (keyed by the OLD p256dh) before dropping
			// the subscription, so the homeserver doesn't retain a pusher
			// pointing at the now-dead endpoint. The new subscription has a new
			// p256dh, so `append: false` on the later setPusher won't replace it.
			const oldP256dh = sub.toJSON().keys?.p256dh;
			if (oldP256dh && cfg.appId) {
				try {
					await client.removePusher(oldP256dh, cfg.appId);
				} catch {
					// best-effort; a stale pusher self-heals (gateway 410 → removal)
				}
			}
			// Best-effort: if unsubscribe rejects, the subscribe() below surfaces a
			// clear error rather than a raw DOMException leaking from here.
			try {
				await sub.unsubscribe();
			} catch {
				// ignore; handled by the subscribe() failure path
			}
			sub = null;
		}
	}
	if (!sub) {
		try {
			sub = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: appServerKey,
			});
		} catch (err) {
			// The push service validates the key at subscribe-time and can reject
			// a structurally-valid-but-unaccepted key (or fail transiently) with a
			// low-level DOMException; map it to an actionable message.
			throw new Error(
				"Could not subscribe to push notifications. The server's VAPID key may be invalid.",
				{ cause: err },
			);
		}
	}

	await client.setPusher(buildPusher(cfg, sub));
}

/**
 * Remove the pusher from the homeserver and unsubscribe the browser from Web
 * Push. Best-effort: a failure to remove the server-side pusher still
 * unsubscribes locally.
 */
export async function disableWebPush(
	client: MatrixClient,
	cfg: PushConfig,
): Promise<void> {
	if (!isPushSupported()) return;
	let registration: ServiceWorkerRegistration;
	try {
		registration = await getReadyRegistration();
	} catch {
		return;
	}
	const sub = await registration.pushManager.getSubscription();
	if (!sub) return;

	const p256dh = sub.toJSON().keys?.p256dh;
	if (p256dh && cfg.appId) {
		try {
			await client.removePusher(p256dh, cfg.appId);
		} catch {
			// Pusher may already be gone (e.g. removed server-side after the
			// subscription expired); proceed to unsubscribe regardless.
		}
	}
	try {
		await sub.unsubscribe();
	} catch {
		// Best-effort (per this function's contract): a rejecting unsubscribe
		// (transient push-service error, pending unsubscribe) shouldn't surface
		// a raw DOMException; the subscription self-heals on a later call.
	}
}
