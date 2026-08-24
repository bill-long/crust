import { useNavigate } from "@solidjs/router";
import { type Component, createSignal, onMount, Show } from "solid-js";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { saveSession } from "../../stores/session";
import { completeOidcLogin, takeOidcReturnTo } from "./oidc";
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
		try {
			const result = await completeOidcLogin(window.location.search);
			saveSession({
				accessToken: result.accessToken,
				refreshToken: result.refreshToken,
				userId: result.userId,
				deviceId: result.deviceId,
				homeserverUrl: result.homeserverUrl,
				oidc: result.oidc,
			});
			// The stashed target was sanitized before stashing; sanitize again
			// here so a tampered sessionStorage value can't redirect us.
			navigate(sanitizeReturnTo(takeOidcReturnTo()), { replace: true });
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
