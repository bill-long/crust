/**
 * Switching which account the app is running as (#533).
 *
 * A switch is the logout teardown (`Layout.runLogout`) minus everything
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
import { CRYPTO_INIT_TIMEOUT_MS, withTimeout } from "../client/cryptoRecovery";
import { endActiveCall } from "../features/room/call/rtc/endCall";
import { closeNotificationSound } from "../features/room/notificationSound";
import { reportError } from "../lib/reportError";
import { setActiveCallRoomId } from "../stores/activeCall";
import {
	activeAccount,
	activeAccountId,
	clearSession,
	freezeAccountScope,
	loadSessions,
	setActiveAccount,
	unfreezeAccountScope,
} from "../stores/session";
import { basePrefix } from "./basePath";

/** Reload into whatever account is active, at the app root. */
function reloadIntoActiveAccount(): void {
	// An assign (not a route navigation) is the point: the document is replaced,
	// so every module-scope singleton is rebuilt for the incoming account.
	window.location.assign(`${basePrefix}/`);
}

/**
 * What the outgoing account owes the server before this document stops being
 * its client: a MatrixRTC withdrawal for any live call, sent while its token is
 * still the one in the client (#474). Shared by every exit from a running
 * session that is not the full logout - switching, and leaving to add an
 * account (which unmounts the provider and then reloads, either of which would
 * kill an unawaited withdrawal in flight).
 */
export async function endSessionForAccountExit(): Promise<void> {
	// Stop the chime first, matching `runLogout`: a message arriving mid-exit
	// must not chime into the account being left.
	closeNotificationSound();
	try {
		await endActiveCall();
	} catch (e) {
		// A withdrawal that cannot land must not trap the user in this account;
		// the membership expires on its own.
		reportError(e, {
			logLabel: "Failed to end the call before leaving the account",
		});
	}
	// `endActiveCall` clears the signal only for the room it tore down, and it is
	// module-global, so a call started during the teardown would otherwise be
	// inherited by the next account.
	setActiveCallRoomId(null);
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
 * teardown - the call has already ended by then.
 *
 * The outgoing account's Web Push registration is deliberately left alone here;
 * re-pointing the pusher at the incoming account is #534's job, and it is
 * tracked there because a stale pusher leaks the other account's message
 * previews onto this device.
 */
export async function switchToAccount(userId: string): Promise<SwitchResult> {
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
	await endSessionForAccountExit();
	// Freeze BEFORE the pointer moves: the account-scoped stores must not rebind
	// to the incoming account while the outgoing one is still on screen.
	freezeAccountScope();
	if (!setActiveAccount(userId)) {
		unfreezeAccountScope();
		return "failed";
	}
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
 * Returns "reloading" when the document is being replaced. `location.assign`
 * only STARTS that, so this document keeps running: a caller that clears a
 * single-flight guard afterwards would re-enable the very action it is
 * guarding, for the whole window before the new document takes over.
 */
export async function finishAccountLogout(
	userId: string,
	wipe: () => Promise<void>,
	goToLogin: () => void,
): Promise<"reloading" | "left"> {
	try {
		await withTimeout(wipe(), CRYPTO_INIT_TIMEOUT_MS, "Account store wipe");
	} catch (e) {
		reportError(e, { logLabel: "Failed to clear the account's stores" });
	}
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
	goToLogin();
	return "left";
}
