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
 *
 * `/login` renders OUTSIDE the auth guard - it has to, since it is what creates
 * the session - so it stays reachable while accounts are logged in: a typed
 * URL, a stale bookmark, or an add-account flow whose router state was lost.
 * Logging in there REPLACES the stored accounts rather than appending to them
 * (`saveSession`, #532), and replacing is what strands the accounts it drops:
 * their tokens are never revoked, so their devices stay alive and push-capable
 * on the homeserver, and there is no UI left to reach them. Turning the visitor
 * around is cheaper and safer than cleaning up after them - a login that
 * silently revoked another account's device would be a surprising thing for a
 * login form to do, and it would need network calls on a path that has none.
 *
 * So: accounts in storage means this visitor already has a session, and the
 * app - not the login form - is where they belong. Two arrivals are exempt:
 *
 *  - `addAccount`, the switcher's deliberate append entry point (#533), in
 *    router state, which a crafted link cannot set;
 *  - the logout tail's landing, which may find residue in storage and must
 *    never be bounced back into it - see {@link takeLogoutLanding}, which is a
 *    module flag rather than router state precisely so the waiver cannot
 *    outlive the navigation that armed it.
 *
 * This reaches `/login/callback` too, without guarding it: every OAuth login
 * that gets to the callback was started on `/login`, so a plain (replacing)
 * OAuth login can only begin where this gate has already let the visitor
 * through. Guarding the callback itself would be worse than useless - it holds
 * a code that has already minted a device, and the exempt `afterLogout` arrival
 * is one where replacing IS the intended outcome.
 *
 * **This is an arrival check, not a persist-time one.** It is decided once at
 * setup, like `AuthGuard`, and deliberately does not track storage: it must not
 * re-evaluate after a successful login on this very page, and the page's own
 * navigation would race it. So it answers "was anyone signed in when this
 * document reached /login", which is the question that stops a user walking
 * into a replacing login - but a form left open in a background tab while
 * another tab signs in is still submittable, and `saveSession` will still
 * replace. Do not build anything destructive on the assumption that a replace
 * can only drop accounts the app has already given up on; closing that window
 * needs a check where the credential is persisted, not here (#551).
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
