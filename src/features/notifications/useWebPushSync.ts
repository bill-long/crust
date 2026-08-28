import type { MatrixClient } from "matrix-js-sdk";
import { onMount } from "solid-js";
import { userSettings } from "../../stores/settings";
import { isPushConfigured, type PushConfig } from "../../types/config";
import { removeOtherAccountPushers } from "./accountPush";
import { enableWebPush, isPushSupported } from "./webPush";

/**
 * On app startup, reconcile who this device is pushed for.
 *
 * Two halves, and they are independent - the second runs whether or not this
 * account wants background notifications:
 *
 *  - Refresh this account's pusher if it has background notifications enabled.
 *    Browser push subscriptions can be rotated or expired (browser update,
 *    storage clear, gateway invalidation), which silently removes the
 *    server-side pusher; re-registering keeps it current. No-op when push is
 *    unsupported/unconfigured or permission isn't granted.
 *  - Take this device's pushkey off every OTHER stored account, so the account
 *    on screen is the only one that can push here (#534) - a pusher an exit
 *    never removed, from a switch made before that existed or from a second
 *    window registering one for the account it runs. Not conditional on the
 *    incoming account's preference: the pusher belongs to another account, and
 *    gating it here would leave the leak in place for exactly the user who
 *    turned background notifications off.
 *
 * The sweep runs FIRST, and the refresh waits for it. They share one push
 * subscription, and the refresh replaces it outright when the VAPID key has
 * changed - a sweep still resolving its pushkey would then read the NEW one and
 * remove that from the other accounts, which is a no-op, leaving their pushers
 * on the old key untouched on the one boot that was meant to be the backstop.
 */
export function useWebPushSync(
	client: MatrixClient,
	pushConfig: PushConfig,
): void {
	onMount(() => {
		if (typeof window === "undefined") return;
		if (!isPushSupported() || !isPushConfigured(pushConfig)) return;
		void (async () => {
			// The RUNNING account, never the persisted pointer (another tab may have
			// moved it). With no user id there is nothing to hold the sweep's list
			// against, and guessing would take the pusher off the account on screen
			// - so it waits for the next boot instead.
			const userId = client.getUserId();
			if (userId) await removeOtherAccountPushers(userId, pushConfig);
			// Read after the sweep, not before: the settings toggle can run during
			// it, and the fresher answer is the right one either way - it registers
			// its own pusher when switched on, and this must not re-register one it
			// just switched off.
			if (!userSettings().backgroundNotifications) return;
			if (Notification.permission !== "granted") return;
			await enableWebPush(client, pushConfig).catch(() => {
				// Best-effort refresh; the settings toggle surfaces actionable errors.
			});
		})();
	});
}
