/**
 * Switching which account the app is running as (#533).
 *
 * A switch is the logout teardown (`app/logout.ts`) minus everything
 * destructive: the outgoing account keeps its token, its crypto store and its
 * per-account data. What it still owes the server is the same thing a logout
 * owes it - a MatrixRTC withdrawal for any live call, sent while the outgoing
 * token is still the one in the client (#474). So the call teardown is awaited
 * here too, before the pointer moves.
 *
 * The rebuild is a **full document load**, not an in-place remount. Discord
 * reloads on switch and so do we, for two reasons that are structural rather
 * than aesthetic:
 *
 *  - `AuthGuard` hands the routed page through as `props.children`, which the
 *    router memoizes. Keying the `ClientProvider` boundary would rebuild the
 *    provider but hand it the SAME already-created `Layout`, so the room
 *    subtree - and with it the composer's in-flight text, attachments and edit
 *    state, which have no isolation of their own beyond being remounted
 *    (`Composer.roomIsolation.test.ts`) - would carry into the new account.
 *    That is the exact leak this feature must not have.
 *  - A dozen module-scope singletons outlive any component (`activeCall`, the
 *    call overlay's PiP window, `notices`, `joinDialog`, `cryptoActions` holds,
 *    the app badge, ...). A reload clears all of them by construction, and,
 *    unlike a hand-maintained reset list, keeps clearing the next one somebody
 *    adds.
 *
 * The cost is one app boot on an action the user takes rarely and deliberately.
 * The new account lands on its own last room because `lastRoom` is per-account
 * (#532) and the shell restores it on boot - no route needs carrying across.
 */
import type { MatrixClient } from "matrix-js-sdk";
import { releaseAppBadge } from "../client/appBadge";
import { CRYPTO_INIT_TIMEOUT_MS, withTimeout } from "../client/cryptoRecovery";
import { markLogoutLanding } from "../features/auth/logoutLanding";
import {
	disableBackgroundNotifications,
	releaseWebPush,
	restoreWebPush,
} from "../features/notifications/accountPush";
import { reportError } from "../lib/reportError";
import { clearNotices } from "../stores/notices";
import {
	activeAccount,
	activeAccountId,
	clearSession,
	freezeAccountScope,
	loadSessions,
	setActiveAccount,
	unfreezeAccountScope,
} from "../stores/session";
import type { PushConfig } from "../types/config";
import { basePrefix } from "./basePath";
import { quiesceLiveSession } from "./quiesceSession";

/** Reload into whatever account is active, at the app root. */
function reloadIntoActiveAccount(): void {
	// An assign (not a route navigation) is the point: the document is replaced,
	// so every module-scope singleton is rebuilt for the incoming account.
	window.location.assign(`${basePrefix}/`);
}

/**
 * What the account being left needs from this document while it is still its
 * client - both items need the outgoing account's token, so neither can be
 * deferred to the incoming one.
 */
export interface AccountExit {
	/** The running client, still holding the outgoing account's token. */
	client: MatrixClient;
	/** Operator push config, for handing back the device's push registration. */
	pushConfig: PushConfig;
}

/**
 * What the outgoing account owes the server before this document stops being
 * its client: a MatrixRTC withdrawal for any live call (#474) and this device's
 * push registration (#534), both sent while its token is still the one in the
 * client. Shared by every exit from a running session that is not the full
 * logout - switching, and leaving to add an account (which unmounts the
 * provider and then reloads, either of which would kill an unawaited withdrawal
 * in flight).
 *
 * `commit` is the caller's point of no return - for a switch, freezing the
 * account scope and moving the stored pointer - and everything is arranged
 * around it. The network work happens BEFORE it, while this document is still
 * wholly the outgoing account: once the pointer moves, the service worker holds
 * the incoming account's media token and account-scoped writes are frozen out,
 * so a multi-second round trip there would leave a still-visible UI fetching
 * media it can no longer authenticate. What follows the commit is synchronous
 * and immediately precedes the reload.
 *
 * The price is that a commit which FAILS has already given the registration
 * back, on a document that goes on running that account - so the failure path
 * puts it back ({@link restoreWebPush}); left alone, the account would sit there
 * with background notifications unregistered while its own settings still say
 * they are on, and nothing re-registers without a reload. On a deployment that
 * has retired push the restore cannot run - registering needs a VAPID key and a
 * gateway, releasing does not - and that is the right way round: the operator
 * has already withdrawn the thing being restored.
 *
 * Returns whether the commit succeeded; a caller with nothing to commit (leaving
 * to add an account) omits it and gets `true`.
 */
export async function endSessionForAccountExit(
	exit: AccountExit,
	commit?: () => boolean,
): Promise<boolean> {
	// The chime, the call teardown and the global call signal, shared with the
	// logout (`quiesceSession.ts`): a withdrawal that cannot land must not trap
	// the user in this account, so each step is caught and the membership
	// expires on its own.
	await quiesceLiveSession("while leaving the account");
	// Background notifications follow the active account, so the one being left
	// gives the device's push registration back - a pusher left behind delivers
	// ITS message previews onto a device that is about to be showing someone
	// else's account. Bounded and non-throwing (`releaseWebPush`): giving up early
	// leaves at worst a pusher pointing at an endpoint this device has already
	// dropped.
	await releaseWebPush(exit.client, exit.pushConfig);
	if (commit) {
		if (!commit()) {
			await restoreWebPush(exit.client, exit.pushConfig);
			return false;
		}
		// The OS badge is one number for the whole install, so the outgoing
		// account's unread count must not greet the incoming one. Clearing rather
		// than recomputing is the honest state: this document is on its way out
		// and the only authority on the incoming count is that account's first
		// sync, which sets the badge from `client/client.tsx`. Synchronous, and
		// after a commit that has frozen the scope, so nothing can put the old
		// count back between here and the reload.
		//
		// Only an exit that HAS committed: leaving to add an account moves no
		// pointer and freezes nothing, and this document goes on running - and
		// syncing - the same account until `/login` unmounts it. That account is
		// still logged in and those unreads are still its own, so a clear there
		// would be both wrong and immediately undone.
		releaseAppBadge();
	}
	return true;
}

/** Why a switch did not happen. */
export type SwitchFailure = "unknown-account" | "failed";

/**
 * The outcome of a switch. "unchanged" is the no-op - this document already
 * runs that account - and is kept distinct from "switching" precisely because
 * callers hold a single-flight guard across the latter: conflating them wedges
 * the UI busy forever on a click that did nothing.
 */
export type SwitchResult = "switching" | "unchanged" | SwitchFailure;

/**
 * Tear the outgoing account down and reload as `userId`.
 *
 * `"switching"` means the document is already being replaced, so nothing the
 * caller does afterwards is guaranteed to run - a caller holding a guard must
 * KEEP it set. `"unchanged"` means this document already runs that account, so
 * nothing happened at all. `"unknown-account"` means the switcher row was stale
 * (removed in another tab, or while the menu was open) and is validated BEFORE
 * the teardown, so it can never cost the user their live call. `"failed"` means
 * storage refused the pointer write, which is only discoverable after the
 * teardown - the call has already ended by then, and the push registration has
 * been given back and put again (see {@link endSessionForAccountExit}), so the
 * account this document goes on running is left as it was.
 *
 * The outgoing account's Web Push registration goes back with the switch
 * (#534): background notifications belong to the account on screen, and a
 * pusher left behind would deliver the other account's message previews onto
 * this device.
 */
export async function switchToAccount(
	userId: string,
	exit: AccountExit,
): Promise<SwitchResult> {
	// "Already the active account" is a property of THIS document's running
	// client, so it reads the per-tab mirror. Storage may name a different
	// account entirely - another tab switched - and this tab would then decline
	// a switch it has never actually made, silently doing nothing.
	if (userId === activeAccount()) return "unchanged";
	// Membership, on the other hand, is storage's to answer: the row being
	// validated went stale precisely because another tab (or another window of
	// the desktop shell) removed the account, which the mirror cannot see.
	// Reading through means a stale row is refused before anything is torn down.
	if (!loadSessions().some((account) => account.userId === userId)) {
		return "unknown-account";
	}
	const committed = await endSessionForAccountExit(exit, () => {
		// Freeze BEFORE the pointer moves: the account-scoped stores must not
		// rebind to the incoming account while the outgoing one is still on
		// screen. It also silences this document's badge writes, so the clear
		// that follows the commit is not undone by its next sync update.
		freezeAccountScope();
		if (setActiveAccount(userId)) return true;
		unfreezeAccountScope();
		return false;
	});
	if (!committed) return "failed";
	reloadIntoActiveAccount();
	return "switching";
}

/**
 * Finish logging the account on screen out: wipe its crypto store, clear it,
 * and leave - in that order, which is what makes the order safe.
 *
 * The wipe goes FIRST because leaving can mean replacing the document, and a
 * reload aborts a delete mid-flight, stranding the departing account's
 * IndexedDB data on disk. It is bounded because `deleteDatabase` BLOCKS while
 * another window still has the store open and the SDK's handler only logs that,
 * so the promise never settles - and leaving is what the user actually asked
 * for. Clearing LAST keeps the window where the pointer has moved but this
 * document still renders the outgoing account down to the call that leaves,
 * so the account-scoped stores never rebind under a UI that is still on screen.
 *
 * Where "leave" goes is the other rule. A route change is not enough when
 * another account remains: `/login` renders outside the auth guard, so the user
 * would be looking at a login form with a perfectly good session live in
 * storage, and logging in there REPLACES, silently discarding that account's
 * unrevoked token. So a remaining account is reloaded into instead.
 *
 * A logout that never reaches storage leaves the account still listed. The
 * account still there is the one whose token was just revoked, so reloading
 * would boot it, fail on the dead token, log out again, and loop; the login
 * page is the only safe destination then.
 *
 * `/login` turns an already-signed-in visitor away (#549), and this is the one
 * arrival that must be let through with accounts still in storage, so it arms
 * the waiver on the way out ({@link markLogoutLanding}). Unconditionally, which
 * also covers the benign race where another tab adds an account between the
 * clear and the navigation.
 *
 * The waiver is blunt: in the rejected-write case storage may ALSO hold a
 * perfectly healthy sibling account, and a plain login on the page this opens
 * replaces that one too, unrevoked. Promoting the sibling instead is the
 * obvious tighter answer and does not work - `setActiveAccount` writes through
 * the same `writeStore` that just refused, with a LARGER payload (it keeps
 * every account, where the removal dropped one), so it fails wherever this
 * branch is reached. Storage is refusing writes; there is no state to move to.
 * So the loop is what gets avoided, and #551 is where doing better belongs.
 *
 * Returns "reloading" when the document is being replaced. `location.assign`
 * only STARTS that, so this document keeps running: a caller that clears a
 * single-flight guard afterwards would re-enable the very action it is
 * guarding, for the whole window before the new document takes over.
 */
export async function finishAccountLogout(
	exit: AccountExit,
	userId: string,
	wipe: () => Promise<void>,
	goToLogin: () => void,
): Promise<"reloading" | "left"> {
	// Before anything else, because clearing the account takes away both the
	// credentials the pusher removal needs and the key its preference is filed
	// under (#532). This is the choke point every logout goes through - the
	// teardown in `app/logout.ts` (menu logout and escape hatch alike) and the
	// expired-session effect in `App` - so no exit can forget it (#534). The
	// foreground logout releases earlier as well, while its token is still
	// valid and the pusher can actually be removed
	// server-side; if that got as far as unsubscribing, this second call finds no
	// subscription and returns, and if it did not, this is the one that closes
	// the leak.
	//
	// Caught, like every other step here: this is the tail EVERY logout goes
	// through, and a throw at its first await would skip the wipe and the clear
	// and leave the account on the device.
	try {
		await disableBackgroundNotifications(exit.client, exit.pushConfig);
	} catch (e) {
		reportError(e, {
			logLabel: "Failed to release background notifications on logout",
		});
	}
	try {
		await withTimeout(wipe(), CRYPTO_INIT_TIMEOUT_MS, "Account store wipe");
	} catch (e) {
		reportError(e, { logLabel: "Failed to clear the account's stores" });
	}
	// Same rule as an account exit: the departing account's unread count is not
	// the promoted account's, and the OS badge is one number for the install. The
	// promoted account's first sync sets it (`client/client.tsx`); on the way to
	// `/login` there is nothing left to count.
	releaseAppBadge();
	// And the same for anything it had to say. A toast belongs to the session
	// that raised it, and on the way to `/login` there is no session left to read
	// it - notably the login route's own "you're already signed in" (#549), which
	// would otherwise still be on screen while the form contradicts it. The app
	// root drops stale notices as it mounts, but that only helps a session that
	// starts; this covers the exit that ends on the login page.
	clearNotices();
	// Storage-backed: another tab may have written it since this document booted,
	// and it is the authority on what will be left.
	const remaining = loadSessions().some((a) => a.userId !== userId);
	// Freeze only when a reload is coming: `reloadIntoActiveAccount` merely
	// STARTS the navigation, so the account-scoped stores would otherwise rebind
	// to the promoted account - re-zooming a UI that is still on screen - and any
	// write until unload would be filed under it. On the way to `/login` the
	// notification has to reach them instead: this document survives, and the
	// stores must actually let go of the account that just left.
	if (remaining) freezeAccountScope();
	if (clearSession(userId) && activeAccountId() !== null) {
		reloadIntoActiveAccount();
		return "reloading";
	}
	if (remaining) unfreezeAccountScope();
	markLogoutLanding();
	goToLogin();
	return "left";
}
