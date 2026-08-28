/**
 * Which account this device's push registration belongs to (#534).
 *
 * Crust holds several accounts but runs one at a time (#531), and background
 * notifications follow that: **the active account is the only one this device
 * is pushed for.** The account you switch away from stops pushing here
 * entirely, which is a privacy rule before it is a product one - a pusher left
 * behind delivers the other account's message previews onto a device the user
 * is now reading someone else's messages on.
 *
 * There is only one browser push subscription per device, so "which account is
 * notified" is decided entirely by which accounts have a pusher registered for
 * that one pushkey on their homeserver. Two mechanisms keep that set down to
 * one:
 *
 *  - {@link releaseWebPush}, on the way out of an account, hands the
 *    registration back while the outgoing token is still the one in the client.
 *    Every exit calls it: the switch and the add-account detour
 *    (`app/accountSwitch.ts`), the logout (`app/Layout.tsx`), and the two
 *    force-logout paths in `app/App.tsx` - which need it most, because they
 *    drop the account from storage with a token that no longer works, putting
 *    it out of the sweep's reach forever. Even there the local unsubscribe
 *    lands, and nothing is delivered to a subscription the browser has dropped.
 *  - {@link removeOtherAccountPushers}, at boot, takes the pushkey off every
 *    account that is stored but not the one running. That is the cleanup for
 *    pushers the exits did not remove: an install that switched accounts before
 *    this shipped has a live stale pusher today that nothing else would ever
 *    reach, and a second window can register one for the account IT is running
 *    against the same subscription. It is not a general backstop for a failed
 *    release - a release that fails has still unsubscribed the browser, so the
 *    pusher it left behind points at a dead endpoint the sweep cannot name (and
 *    does not need to; nothing is delivered to it).
 *
 * One path escapes both halves: a plain login on `/login`, which REPLACES the
 * account list rather than appending to it (#532), so the account it displaces
 * leaves with its credentials and the sweep has nothing left to remove its
 * pusher with. That is #549 - guarding `/login` against a visitor who is
 * already signed in closes it structurally, and nothing here can act once the
 * token is gone.
 *
 * Not left to `append: false` on `setPusher`, which asks the homeserver to drop
 * other USERS' pushers for the same app id and pushkey. It only fires when the
 * incoming account registers a pusher at all - an account with background
 * notifications off would inherit the leak - it cannot reach an account on a
 * different homeserver, and it is a request to the server rather than something
 * this device can confirm. Fine as a belt; not the braces.
 */
import type { MatrixClient } from "matrix-js-sdk";
import { createAccountClient } from "../../client/accountLogout";
import { withTimeout } from "../../client/cryptoRecovery";
import { reportError } from "../../lib/reportError";
import { loadSessions } from "../../stores/session";
import { userSettings } from "../../stores/settings";
import { isPushConfigured, type PushConfig } from "../../types/config";
import {
	currentPushKey,
	disableWebPush,
	enableWebPush,
	isPushSupported,
} from "./webPush";

/**
 * How long any one push registration request may take before it is given up on.
 *
 * Nothing here is worth waiting on indefinitely. On the way out of an account
 * this sits between the user's click and the switch actually happening, and a
 * homeserver that is slow or unreachable would hold them in the account they
 * asked to leave. In the boot sweep it bounds each account separately, so one
 * unreachable homeserver cannot swallow the sweep - it delays it by its own
 * timeout and no more. The sweep runs ahead of the active account's own pusher
 * refresh, so with several unreachable accounts that delay does add up before
 * the refresh starts; the refresh is background repair with nobody waiting on
 * it, and every one of those accounts genuinely needs asking.
 */
const PUSH_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Hand this device's push registration back for the account that is leaving -
 * and for the settings toggle, which is the same act for a different reason.
 *
 * Every exit out of a running session reaches it (switching, leaving to add an
 * account, and every logout, through `finishAccountLogout`), and it must run
 * while the outgoing account's token is still the one in `client`, which is why
 * it is part of the account-exit teardown rather than something the incoming
 * document does.
 *
 * Gated on the DEVICE, not on the account's `backgroundNotifications`: whether
 * there is anything to hand back is answered by whether this device holds a push
 * subscription, which `disableWebPush` checks and which is true of the whole
 * install. The setting is a per-tab signal that no `storage` event refreshes
 * (#533, invariant 2) - a second tab enabling background notifications is
 * invisible here, and gating on it would skip the release for the account that
 * has a live pusher, on the one path where nothing can clean up afterwards.
 *
 * Never throws and never blocks for longer than {@link PUSH_REQUEST_TIMEOUT_MS}.
 * An exit the user is waiting on must not hang on notification cleanup, and
 * giving up early is cheap: `disableWebPush` unsubscribes the browser before it
 * talks to the server, so what a timeout can leave behind is a pusher pointing
 * at an endpoint this device no longer holds.
 */
export async function releaseWebPush(
	client: MatrixClient,
	cfg: PushConfig,
): Promise<void> {
	if (!isPushConfigured(cfg)) return;
	try {
		await withTimeout(
			disableWebPush(client, cfg),
			PUSH_REQUEST_TIMEOUT_MS,
			"Push registration release",
		);
	} catch (e) {
		reportError(e, {
			logLabel: "Failed to release the push registration on account exit",
		});
	}
}

/**
 * Put back the registration {@link releaseWebPush} gave up, for an account this
 * document turned out not to be leaving after all - a switch whose pointer
 * write was refused, which leaves this document running the account it tried to
 * leave. Without it that account keeps its `backgroundNotifications` setting
 * switched on with nothing registered behind it, and nothing re-registers
 * before the next boot.
 *
 * The same conditions the boot refresh applies (`useWebPushSync`), because it is
 * the same act: registering this device for the account on screen. Unlike the
 * release, this one does read `backgroundNotifications` - "should this account
 * have a pusher" is exactly what the setting answers, and putting one back that
 * the account never asked for would be worse than leaving it off. Bounded and
 * non-throwing, like the release - the caller is already reporting a failed
 * switch and has nothing to do with a second one.
 */
export async function restoreWebPush(
	client: MatrixClient,
	cfg: PushConfig,
): Promise<void> {
	if (!userSettings().backgroundNotifications) return;
	if (!isPushSupported() || !isPushConfigured(cfg)) return;
	if (Notification.permission !== "granted") return;
	try {
		await withTimeout(
			enableWebPush(client, cfg),
			PUSH_REQUEST_TIMEOUT_MS,
			"Push registration restore",
		);
	} catch (e) {
		reportError(e, {
			logLabel: "Failed to restore the push registration after a failed switch",
		});
	}
}

/**
 * Take this device's pushkey off every account that is stored but is not the
 * one this document is running, so only the active account can push here.
 *
 * `activeUserId` is the account THIS document runs, not whatever storage
 * currently calls active: it is the account whose pusher the same hook is about
 * to register, and removing the one we are registering would be a race with
 * ourselves. Two tabs running different accounts do contest the device's single
 * subscription, and this resolves it the only way it can - the most recent boot
 * owns it. That is also the correct answer, since it is the account the user
 * just chose.
 *
 * Removal is by the pushkey the device is reachable at NOW. A pusher stranded on
 * an older one - the release unsubscribed the browser but its removal failed -
 * is already harmless, since nothing is delivered to a subscription this browser
 * no longer holds, and the push service expires it (410, and the gateway drops
 * the pusher) without help from here.
 *
 * The throwaway client refreshes tokens ({@link createAccountClient}), which is
 * not free: an inactive OAuth account's access token is stale by definition, so
 * without it the sweep would 401 on exactly the accounts it exists to clean up -
 * but refreshing can rotate a token another window is running that account with,
 * the two-window hazard `features/auth/oidcRefresh.ts` documents. Taken
 * deliberately: the sweep runs once per boot and never on a timer, and a sweep
 * that cannot authenticate is a sweep that does nothing.
 *
 * Best-effort per account: an account whose credential no longer works must not
 * stop the sweep from reaching the next one. Console-only - nothing here was
 * user-initiated, so there is nothing to surface (see AGENTS.md error handling).
 */
export async function removeOtherAccountPushers(
	activeUserId: string,
	cfg: PushConfig,
): Promise<void> {
	if (!isPushConfigured(cfg)) return;
	// Storage, not the reactive mirror: an account added or removed in another
	// tab is exactly the kind this sweep exists to catch, and the mirror cannot
	// see it (#533, invariant 2).
	const others = loadSessions().filter(
		(account) => account.userId !== activeUserId,
	);
	if (others.length === 0) return;
	// Resolved once, after the cheap checks: on a single-account install (the
	// common case) this never waits on the service worker at all.
	const pushKey = await currentPushKey();
	if (!pushKey) return;
	for (const account of others) {
		try {
			await withTimeout(
				createAccountClient(account).removePusher(pushKey, cfg.appId),
				PUSH_REQUEST_TIMEOUT_MS,
				`Stale pusher removal for ${account.userId}`,
			);
		} catch (e) {
			reportError(e, {
				logLabel: `Failed to remove the stale pusher for ${account.userId}`,
			});
		}
	}
}
