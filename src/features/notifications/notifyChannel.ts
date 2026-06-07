/**
 * Coordination channel between the service worker and open app clients for
 * background Web Push. On each push the SW broadcasts a `ping`; live clients
 * reply with a `pong` declaring whether they will surface the event in-app.
 * The SW suppresses its own background notification only when a client confirms
 * (`canNotify: true`), so an open-but-incapable tab (login page, suspended /
 * discarded tab, or one with desktop notifications disabled) no longer silently
 * swallows the alert. See `sw.ts` `handlePush` and `useNotifications.ts`.
 *
 * The channel name is scoped to the deployment base path so two Crust instances
 * sharing an origin don't cross-suppress each other's notifications.
 */
export const NOTIFY_CHANNEL_NAME = `crust-notify:${import.meta.env.BASE_URL}`;

export interface NotifyPing {
	type: "ping";
	nonce: string;
}

export interface NotifyPong {
	type: "pong";
	nonce: string;
	/** True when this client is synced and will surface the event in-app
	 *  (focused, so the user sees it live, or able to show a desktop
	 *  notification). */
	canNotify: boolean;
}

export interface CanNotifyInput {
	/** The app has completed initial sync (post-Prepared) and is processing
	 *  live timeline events. Mirrors AppSyncState === "live". */
	live: boolean;
	/** The app window is focused, so the user sees incoming messages live. */
	focused: boolean;
	/** The user's desktopNotifications setting is enabled. */
	desktopNotificationsEnabled: boolean;
	/** Notification permission has been granted (and the API is available). */
	notificationPermissionGranted: boolean;
}

/** Decide whether this client will surface a pushed event in-app, mirroring the
 *  in-app notification path's gating. The client confirms (so the SW suppresses
 *  its background notification) only when the app is live AND either focused
 *  (the user sees the message live) or able to pop a desktop notification.
 *  Pure so it can be unit-tested without a DOM / service-worker harness. */
export function computeCanNotify(input: CanNotifyInput): boolean {
	const canDesktop =
		input.desktopNotificationsEnabled && input.notificationPermissionGranted;
	return input.live && (input.focused || canDesktop);
}
