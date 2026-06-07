import type { MatrixClient } from "matrix-js-sdk";
import { onMount } from "solid-js";
import { userSettings } from "../../stores/settings";
import { isPushConfigured, type PushConfig } from "../../types/config";
import { enableWebPush, isPushSupported } from "./webPush";

/**
 * On app startup, refresh the Web Push pusher if the user has background
 * notifications enabled. Browser push subscriptions can be rotated or expired
 * (browser update, storage clear, gateway invalidation), which silently
 * removes the server-side pusher; re-registering keeps it current. No-op when
 * push is unsupported/unconfigured or permission isn't granted.
 */
export function useWebPushSync(
	client: MatrixClient,
	pushConfig: PushConfig,
): void {
	onMount(() => {
		if (typeof window === "undefined") return;
		if (!userSettings().backgroundNotifications) return;
		if (!isPushSupported() || !isPushConfigured(pushConfig)) return;
		if (Notification.permission !== "granted") return;
		void enableWebPush(client, pushConfig).catch(() => {
			// Best-effort refresh; the settings toggle surfaces actionable errors.
		});
	});
}
