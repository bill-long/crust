import { useLocation, useNavigate } from "@solidjs/router";
import type { Component, JSX } from "solid-js";
import { onMount } from "solid-js";
import { carryNoticeIntoSession, clearNotices } from "../../stores/notices";
import { loadSessions } from "../../stores/session";
import { takeLogoutLanding } from "./logoutLanding";
import {
	isAddAccountState,
	type LoginState,
	sanitizeReturnTo,
} from "./returnTo";

/**
 * Keep an already-signed-in visitor off the login form (#549).
 * The account switcher is the deliberate add-account entry point. A logout
 * landing is also exempt so storage failures cannot trap a revoked session in
 * a login/logout loop (see takeLogoutLanding).
 *
 * This is an arrival check, decided once at setup. Tracking storage here would
 * race the form's own successful-login navigation. A stale form or an OAuth
 * callback may still finish after another tab signs in; persistLogin protects
 * those accounts at commit time (#551), including accounts with no running tab.
 * Only credentials identified by this tab's logout tail may be replaced.
 */
const LoginGate: Component<{ children: JSX.Element }> = (props) => {
	const navigate = useNavigate();
	const location = useLocation();
	// Storage, not the `accounts()` mirror: the mirror is per-tab and cannot see
	// an account another tab added, and "is anyone signed in on this install" is
	// exactly a question about what EXISTS (#533, invariant 2).
	// Taken on its own line, never inside the `&&` below: reading the waiver is
	// what disarms it, and a short-circuited read would leave it primed for a
	// later, unrelated visit to this route.
	const afterLogout = takeLogoutLanding();
	const signedIn =
		loadSessions().length > 0 &&
		!isAddAccountState(location.state) &&
		!afterLogout;

	onMount(() => {
		if (!signedIn) {
			// Anything carried for a session that is about to start is ours, and
			// this visitor is not starting one - they are getting the form. Left
			// alone it would surface on top of whatever session they log into next.
			// Nothing renders notices on this route, so clearing is the whole slot.
			clearNotices();
			return;
		}
		// Say why: the redirect is otherwise indistinguishable from the app
		// ignoring the URL, and the user who typed /login was most likely after a
		// second account - which lives behind the switcher now. Carried rather
		// than pushed, because the toast renderer is inside the session this
		// redirect is on its way into and clears what it finds as it mounts.
		carryNoticeIntoSession(
			"You're already signed in. Use the account switcher to add another account.",
		);
		// Honour the deep link if there is one. `AuthGuard` is its only producer
		// and only fires with no session, so arriving here with BOTH a `returnTo`
		// and accounts in storage means another tab finished a login in between -
		// and the room the user actually clicked should not be the casualty.
		// `sanitizeReturnTo` refuses `/login*`, so this cannot re-enter the gate.
		// `replace` so the login URL leaves no history entry to go Back into.
		const target = sanitizeReturnTo(
			(location.state as LoginState | null)?.returnTo,
		);
		navigate(target, { replace: true });
	});

	// Not `<Show>`: returning without touching `props.children` - which is a
	// getter - means the login chunk's Suspense boundary is never created for a
	// visitor being sent away. It paints rather than rendering nothing: the
	// router holds this frame for the whole transition to the target route, and
	// no element below `#root` sets a background, so `null` would flash the UA
	// white through a dark-only app. Same surface the login chunk's own fallback
	// uses.
	if (signedIn) return <div class="h-full bg-surface-0" />;
	return <>{props.children}</>;
};

export { LoginGate };
