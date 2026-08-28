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
 * Tear the outgoing account down and reload as `userId`.
 *
 * `"switching"` means the document is already being replaced, so nothing the
 * caller does afterwards is guaranteed to run. `"unknown-account"` means the
 * switcher row was stale (removed in another tab, or while the menu was open);
 * `"failed"` means storage refused the write. Neither failure touches the live
 * session - the target is validated BEFORE the teardown, so a stale row can
 * never cost the user their call.
 *
 * The outgoing account's Web Push registration is deliberately left alone here;
 * re-pointing the pusher at the incoming account is #534's job, and it is
 * tracked there because a stale pusher leaks the other account's message
 * previews onto this device.
 */
export async function switchToAccount(
	userId: string,
): Promise<"switching" | SwitchFailure> {
	// "Already the active account" is a property of THIS document's running
	// client, so it reads the per-tab mirror. Storage may name a different
	// account entirely - another tab switched - and this tab would then decline
	// a switch it has never actually made, silently doing nothing.
	if (userId === activeAccount()) return "switching";
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
 * Finish logging the account on screen out: clear it, wipe its crypto store,
 * and leave - in the order those three have to happen in.
 *
 * Where "leave" goes is the first rule. A route change is not enough when
 * another account remains: `/login` renders outside the auth guard, so the user
 * would be looking at a login form with a perfectly good session live in
 * storage, and logging in there REPLACES, silently discarding that account's
 * unrevoked token. So a remaining account is reloaded into instead.
 *
 * When the leave happens is the second. A reload replaces the document and
 * would abort the wipe mid-delete, leaving the departing account's IndexedDB
 * data on disk - so the wipe is awaited first. A route to `/login` leaves this
 * document running, so it goes first and the wipe follows: the user never
 * watches the stopped app UI while a delete awaits.
 *
 * `clear` reporting false means the logout never reached storage. The account
 * still listed there is the one whose token was just revoked, so reloading
 * would boot it, fail on the dead token, log out again, and loop; the login
 * page is the only safe destination then.
 */
export async function finishAccountLogout(
	clear: () => boolean,
	wipe: () => Promise<void>,
	goToLogin: () => void,
): Promise<void> {
	// Freeze before clearing: `clear` moves the pointer, and the account-scoped
	// stores must not follow it while the OUTGOING account is still the one on
	// screen - that is a visible re-zoom, and any write in the meantime lands
	// under the wrong account's key.
	freezeAccountScope();
	// Storage-backed: the logout that just ran wrote there, and another tab may
	// have too - it is the authority on what is left.
	const reloading = clear() && activeAccountId() !== null;
	if (!reloading) {
		// This document survives a route to `/login` and can host the next login,
		// so the freeze must not outlive the exit.
		unfreezeAccountScope();
		goToLogin();
	}
	try {
		// Bounded, because `deleteDatabase` BLOCKS while another window still has
		// the store open and the SDK's handler only logs that - the promise never
		// settles. Leaving is what the user asked for; an unbounded await would
		// strand them on a stopped UI holding a revoked token, which is the
		// failure `Layout.handleLogout`'s single-flight guard exists to prevent.
		await withTimeout(wipe(), CRYPTO_INIT_TIMEOUT_MS, "Account store wipe");
	} catch (e) {
		reportError(e, { logLabel: "Failed to clear the account's stores" });
	}
	if (reloading) reloadIntoActiveAccount();
}
