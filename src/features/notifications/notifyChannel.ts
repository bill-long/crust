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
	/** The pushed event's `event_id`, so clients can answer per-event whether
	 *  they will surface *this* event in-app rather than a coarse per-client
	 *  capability. Optional for backward/forward compatibility; when absent a
	 *  client treats the event as not-yet-surfaced. */
	eventId?: string;
}

export interface NotifyPong {
	type: "pong";
	nonce: string;
	/** True when this client will surface *this event* in-app (focused, so the
	 *  user sees it live; or it popped a desktop notification for the event). */
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
	/** This client actually surfaced the pinged event in-app (it popped a
	 *  desktop notification for it). Only consulted on the unfocused desktop
	 *  path: a bare-notify event the in-app path doesn't pop is *not* surfaced,
	 *  so the SW must still show its background notification. */
	eventSurfacedInApp: boolean;
}

/** Decide whether this client will surface the pinged event in-app, mirroring
 *  the in-app notification path's per-event gating. The client confirms (so the
 *  SW suppresses its background notification) only when the app is live AND
 *  either focused (the user sees the message live) or it actually popped a
 *  desktop notification for this specific event. A bare-notify event while
 *  unfocused is not surfaced even with desktop notifications enabled, so the SW
 *  still shows it (see issue #242). Pure so it can be unit-tested without a
 *  DOM / service-worker harness. */
export function computeCanNotify(input: CanNotifyInput): boolean {
	if (!input.live) return false;
	if (input.focused) return true;
	const canDesktop =
		input.desktopNotificationsEnabled && input.notificationPermissionGranted;
	if (!canDesktop) return false;
	return input.eventSurfacedInApp;
}

/** Tracks the `event_id`s a client has surfaced in-app (popped a desktop
 *  notification for) so it can answer the SW's per-event ping. Bounded: a `Set`
 *  preserves insertion order, so once `cap` is exceeded the oldest entry is
 *  evicted, keeping memory constant for a long-lived session. */
export interface SurfacedEventTracker {
	/** Mark an event_id as surfaced. Idempotent. */
	record(eventId: string): void;
	/** Whether the event_id is still tracked as surfaced. */
	has(eventId: string): boolean;
	/** Drop all tracked event_ids (e.g. on hook cleanup). */
	clear(): void;
}

export function createSurfacedEventTracker(cap = 256): SurfacedEventTracker {
	const ids = new Set<string>();
	return {
		record(eventId: string): void {
			if (ids.has(eventId)) return;
			ids.add(eventId);
			if (ids.size > cap) {
				const oldest = ids.values().next().value;
				if (oldest !== undefined) ids.delete(oldest);
			}
		},
		has(eventId: string): boolean {
			return ids.has(eventId);
		},
		clear(): void {
			ids.clear();
		},
	};
}
