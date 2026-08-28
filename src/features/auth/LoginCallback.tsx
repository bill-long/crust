import { useNavigate } from "@solidjs/router";
import { type Component, createSignal, onMount, Show } from "solid-js";
import { basePrefix } from "../../app/basePath";
import { revokeAccountToken } from "../../client/accountLogout";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import {
	addSession,
	freezeAccountScope,
	loadSessions,
	MAX_ACCOUNTS,
	saveSession,
	unfreezeAccountScope,
} from "../../stores/session";
import {
	completeOidcLogin,
	takeOidcAddAccount,
	takeOidcReturnTo,
} from "./oidc";
import { sanitizeReturnTo } from "./returnTo";

/**
 * Landing route for the OAuth2 redirect (`/login/callback`). Exchanges the
 * authorization code, persists the session, and hands off to the auth
 * guard, which boots the real client from the stored session.
 */
const LoginCallback: Component = () => {
	const navigate = useNavigate();
	const [error, setError] = createSignal("");
	// Whether an account is still signed in on this device, read when the
	// callback lands. It decides where the error state's way out goes: with an
	// account still live, `/login` is not it - the guard there turns a
	// signed-in visitor around anyway (#549), and a plain login there REPLACES.
	// Adding an account is the usual way to be in that position but not the only
	// one, so this asks storage rather than asking whether we were adding: a
	// plain login that failed while another tab signed in belongs back in the
	// app too.
	//
	// It deliberately does NOT gate the persist below. Refusing a login because
	// storage lists an account would trap the case that most needs to get
	// through: an account a logout revoked but could not remove, where replacing
	// it IS the way out. Closing the window where a successful plain login
	// replaces a LIVE account needs to tell those two apart, which nothing here
	// can - see LoginGate's docblock, and #551.
	const [signedIn, setSignedIn] = createSignal(false);

	onMount(async () => {
		// Taken BEFORE the exchange, which throws on an OP error, a replayed state
		// or a failed token request - and never resolves at all if the user
		// abandons the flow at the OP. A flag left armed would turn the next plain
		// OAuth login in this tab into an append, which is the behaviour reserved
		// for the switcher's explicit entry point (#533).
		const isAdding = takeOidcAddAccount();
		// Before the exchange, so it describes the device as the user left it
		// rather than as this callback has since changed it.
		setSignedIn(loadSessions().length > 0);
		try {
			const result = await completeOidcLogin(window.location.search);
			// The stashed target was sanitized before stashing; sanitize again
			// here so a tampered sessionStorage value can't redirect us.
			const target = sanitizeReturnTo(takeOidcReturnTo());
			const session = {
				accessToken: result.accessToken,
				refreshToken: result.refreshToken,
				userId: result.userId,
				deviceId: result.deviceId,
				homeserverUrl: result.homeserverUrl,
				oidc: result.oidc,
			};
			if (isAdding) {
				// Same as the password path: the pointer moves and a reload follows,
				// so the account-scoped stores must not rebind in the window before
				// the replacement document takes over.
				freezeAccountScope();
				let added = false;
				try {
					added = addSession(session);
				} finally {
					// `finally`: addSession persists with a RAW setItem and can throw,
					// which would leave this document frozen on the error screen.
					if (!added) unfreezeAccountScope();
				}
				if (!added) {
					// The login already minted a device on the homeserver. Revoke it
					// rather than orphaning a token this app will never hold again.
					await revokeAccountToken(session);
					setError(
						`You can be logged into ${MAX_ACCOUNTS} accounts at once. Log out of one first.`,
					);
					return;
				}
				// Reload rather than navigate: the added account starts at its own
				// root with no module-scope state carried over, exactly as a switch
				// does (see `app/accountSwitch.ts`).
				window.location.assign(`${basePrefix}/`);
				return;
			}
			saveSession(session);
			navigate(target, { replace: true });
		} catch (err: unknown) {
			setError(userFacingErrorMessage(err, "Login failed"));
		}
	});

	return (
		<div class="flex h-full items-center justify-center bg-surface-0 p-4">
			<div class="w-full max-w-sm text-center">
				<Show
					when={error()}
					fallback={
						<>
							<div class="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							<p class="text-text-muted">Completing login…</p>
						</>
					}
				>
					<p class="rounded bg-danger-bg/50 px-3 py-2 text-sm text-danger-text-bright">
						{error()}
					</p>
					<Show
						when={signedIn()}
						fallback={
							// No logout waiver is armed for this navigation, deliberately.
							// A failed callback is not a logout, and letting one wave the
							// login guard aside would hand any bad exchange the ability to
							// reach a replacing login. With logout residue in storage that
							// costs one self-healing round trip through the dead session;
							// the alternative costs the guard.
							<button
								type="button"
								onClick={() => navigate("/login", { replace: true })}
								class="mt-4 rounded-lg bg-surface-3 px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-4 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-border-focus"
							>
								Back to log in
							</button>
						}
					>
						{/* A reload, not a route: the app is not mounted on this route,
						    and the account still signed in is the one to return to. */}
						<button
							type="button"
							onClick={() => window.location.assign(`${basePrefix}/`)}
							class="mt-4 rounded-lg bg-surface-3 px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-4 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-border-focus"
						>
							Back to app
						</button>
					</Show>
				</Show>
			</div>
		</div>
	);
};

export { LoginCallback };
