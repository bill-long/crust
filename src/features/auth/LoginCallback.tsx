import { useNavigate } from "@solidjs/router";
import { type Component, createSignal, onMount, Show } from "solid-js";
import { basePrefix } from "../../app/basePath";
import { revokeAccountToken } from "../../client/accountLogout";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { addSession, MAX_ACCOUNTS, saveSession } from "../../stores/session";
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

	onMount(async () => {
		// Taken BEFORE the exchange, which throws on an OP error, a replayed state
		// or a failed token request - and never resolves at all if the user
		// abandons the flow at the OP. A flag left armed would turn the next plain
		// OAuth login in this tab into an append, which is the behaviour reserved
		// for the switcher's explicit entry point (#533).
		const adding = takeOidcAddAccount();
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
			if (adding) {
				if (!addSession(session)) {
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
					<button
						type="button"
						onClick={() => navigate("/login", { replace: true })}
						class="mt-4 rounded-lg bg-surface-3 px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-4 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-border-focus"
					>
						Back to log in
					</button>
				</Show>
			</div>
		</div>
	);
};

export { LoginCallback };
