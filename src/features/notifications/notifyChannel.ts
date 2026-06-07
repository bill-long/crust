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
