import { useLocation, useNavigate } from "@solidjs/router";
import {
	createClient,
	type ILoginFlowsResponse,
	type LoginResponse,
	type OidcClientConfig,
} from "matrix-js-sdk";
import { type Component, createSignal, Match, Show, Switch } from "solid-js";
import { useConfig } from "../../app/ConfigProvider";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { saveSession } from "../../stores/session";
import { discoverHomeserver } from "./discovery";
import { probeDelegatedAuth, startOidcLogin, stashOidcReturnTo } from "./oidc";
import { sanitizeReturnTo } from "./returnTo";

/** What a homeserver supports, probed once before the user picks a method. */
interface ServerCapabilities {
	baseUrl: string;
	/** Validated OP metadata when the server delegates auth (MSC3861). */
	delegatedAuth: OidcClientConfig | null;
	/** The server still advertises m.login.password. */
	hasPassword: boolean;
}

const LoginPage: Component = () => {
	const config = useConfig();
	const navigate = useNavigate();
	const location = useLocation();

	const [homeserver, setHomeserver] = createSignal(config.defaultHomeserver);
	const [username, setUsername] = createSignal("");
	const [password, setPassword] = createSignal("");
	const [error, setError] = createSignal("");
	const [loading, setLoading] = createSignal(false);
	const [redirecting, setRedirecting] = createSignal(false);
	const [capabilities, setCapabilities] =
		createSignal<ServerCapabilities | null>(null);

	// The deep-linked target the auth guard sent us from (#338), sanitized to
	// an in-app path. The password flow passes it through router state; the
	// OAuth flow stashes it in sessionStorage because the full-page redirect
	// to the OP drops router state.
	const returnTo = (): string =>
		sanitizeReturnTo(
			(location.state as { returnTo?: unknown } | null)?.returnTo,
		);

	/** Stage 1: discover the homeserver and probe its login methods. */
	const handleServerSubmit = async (e: Event): Promise<void> => {
		e.preventDefault();
		setError("");
		setLoading(true);

		try {
			const baseUrl = await discoverHomeserver(homeserver());
			const tempClient = createClient({ baseUrl });

			// Legacy flows and delegated auth are independent probes - run them
			// together so the methods stage appears after one round trip.
			let flows: ILoginFlowsResponse;
			let delegatedAuth: OidcClientConfig | null;
			try {
				[flows, delegatedAuth] = await Promise.all([
					tempClient.loginFlows(),
					probeDelegatedAuth(baseUrl),
				]);
			} catch {
				throw new Error(
					"Could not contact the homeserver. Check the server address.",
				);
			}

			const hasPassword = flows.flows.some(
				(f) => f.type === "m.login.password",
			);
			if (!hasPassword && !delegatedAuth) {
				const hasSSO = flows.flows.some(
					(f) => f.type === "m.login.sso" || f.type === "m.login.cas",
				);
				if (hasSSO) {
					throw new Error(
						"This server only supports legacy SSO login, which Crust doesn't support.",
					);
				}
				throw new Error("This server doesn't support password or OAuth login.");
			}

			setCapabilities({ baseUrl, delegatedAuth, hasPassword });
		} catch (err: unknown) {
			setError(userFacingErrorMessage(err, "Login failed"));
		} finally {
			setLoading(false);
		}
	};

	/** OAuth path: stash the return target and redirect the page to the OP. */
	const handleOidcLogin = async (): Promise<void> => {
		const caps = capabilities();
		if (!caps?.delegatedAuth) return;
		setError("");
		setRedirecting(true);
		try {
			stashOidcReturnTo(returnTo());
			const authorizationUrl = await startOidcLogin(
				caps.delegatedAuth,
				caps.baseUrl,
			);
			window.location.assign(authorizationUrl);
			// Navigation is in flight; keep `redirecting` set so the button
			// stays disabled until the page unloads.
		} catch (err: unknown) {
			setError(userFacingErrorMessage(err, "Could not start OAuth login"));
			setRedirecting(false);
		}
	};

	/** Password path: unchanged from the pre-OAuth flow. */
	const handlePasswordSubmit = async (e: Event): Promise<void> => {
		e.preventDefault();
		const caps = capabilities();
		if (!caps) return;
		setError("");
		setLoading(true);

		try {
			const tempClient = createClient({ baseUrl: caps.baseUrl });
			let response: LoginResponse;
			try {
				response = await tempClient.loginRequest({
					type: "m.login.password",
					identifier: {
						type: "m.id.user",
						user: username(),
					},
					password: password(),
					initial_device_display_name: "Crust",
				});
			} catch (err: unknown) {
				throw new Error(userFacingErrorMessage(err, "Login failed"));
			}

			// Prefer well_known from the login response for the persisted URL
			let resolvedUrl = caps.baseUrl;
			if (response.well_known?.["m.homeserver"]?.base_url) {
				const candidate = response.well_known["m.homeserver"].base_url.replace(
					/\/+$/,
					"",
				);
				try {
					const parsed = new URL(candidate);
					if (parsed.protocol === "http:" || parsed.protocol === "https:") {
						resolvedUrl = candidate;
					}
				} catch {
					// Malformed well_known URL — keep the discovered baseUrl
				}
			}

			saveSession({
				accessToken: response.access_token,
				userId: response.user_id,
				deviceId: response.device_id,
				homeserverUrl: resolvedUrl,
			});

			navigate(returnTo(), { replace: true });
		} catch (err: unknown) {
			setError(userFacingErrorMessage(err, "Login failed"));
		} finally {
			setLoading(false);
		}
	};

	const serverHost = (): string => {
		const caps = capabilities();
		if (!caps) return "";
		try {
			return new URL(caps.baseUrl).host;
		} catch {
			return caps.baseUrl;
		}
	};

	return (
		<div class="flex h-full justify-center overflow-y-auto bg-surface-0 p-4">
			<div class="my-auto w-full max-w-sm">
				<h1 class="mb-8 text-center text-3xl font-bold text-text-primary">
					Crust
				</h1>

				<Switch>
					{/* Stage 1: which homeserver? */}
					<Match when={capabilities() === null}>
						<form onSubmit={handleServerSubmit} class="space-y-4">
							<div>
								<label
									for="homeserver"
									class="mb-1 block text-sm text-text-muted"
								>
									Homeserver
								</label>
								<input
									id="homeserver"
									type="text"
									value={homeserver()}
									onInput={(e) => setHomeserver(e.currentTarget.value)}
									placeholder="strange.pizza"
									class="w-full rounded bg-surface-2 px-3 py-2 text-text-primary placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-accent-hover"
									required
								/>
							</div>

							<Show when={error()}>
								<p class="rounded bg-danger-bg/50 px-3 py-2 text-sm text-danger-text-bright">
									{error()}
								</p>
							</Show>

							<button
								type="submit"
								disabled={loading()}
								class="w-full rounded bg-accent py-2 font-semibold text-text-primary transition-colors hover:bg-accent-hover disabled:opacity-50"
							>
								{loading() ? "Checking server…" : "Continue"}
							</button>
						</form>
					</Match>

					{/* Stage 2: pick a login method the probed server supports. */}
					<Match when={capabilities() !== null}>
						<div class="space-y-4">
							<div class="flex items-center justify-between gap-2">
								<p class="min-w-0 truncate text-sm text-text-muted">
									{serverHost()}
								</p>
								<button
									type="button"
									onClick={() => {
										setCapabilities(null);
										setError("");
									}}
									class="shrink-0 text-sm text-text-secondary underline-offset-2 transition-colors hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
								>
									Use a different server
								</button>
							</div>

							<Show when={capabilities()?.delegatedAuth} keyed>
								{(_) => (
									<button
										type="button"
										onClick={handleOidcLogin}
										disabled={redirecting() || loading()}
										class="w-full rounded bg-accent py-2 font-semibold text-text-primary transition-colors hover:bg-accent-hover disabled:opacity-50"
									>
										{redirecting()
											? "Redirecting…"
											: `Continue with ${serverHost()}`}
									</button>
								)}
							</Show>

							<Show
								when={
									capabilities()?.delegatedAuth && capabilities()?.hasPassword
								}
							>
								<div class="flex items-center gap-3">
									<div class="h-px flex-1 bg-border-subtle" />
									<span class="text-xs text-text-faint">or</span>
									<div class="h-px flex-1 bg-border-subtle" />
								</div>
							</Show>

							<Show when={capabilities()?.hasPassword}>
								<form onSubmit={handlePasswordSubmit} class="space-y-4">
									<div>
										<label
											for="username"
											class="mb-1 block text-sm text-text-muted"
										>
											Username
										</label>
										<input
											id="username"
											type="text"
											value={username()}
											onInput={(e) => setUsername(e.currentTarget.value)}
											placeholder="username"
											autocomplete="username"
											class="w-full rounded bg-surface-2 px-3 py-2 text-text-primary placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-accent-hover"
											required
										/>
									</div>
									<div>
										<label
											for="password"
											class="mb-1 block text-sm text-text-muted"
										>
											Password
										</label>
										<input
											id="password"
											type="password"
											value={password()}
											onInput={(e) => setPassword(e.currentTarget.value)}
											placeholder="••••••••"
											autocomplete="current-password"
											class="w-full rounded bg-surface-2 px-3 py-2 text-text-primary placeholder:text-text-disabled focus:outline-none focus:ring-2 focus:ring-accent-hover"
											required
										/>
									</div>

									<button
										type="submit"
										disabled={loading() || redirecting()}
										class="w-full rounded bg-accent py-2 font-semibold text-text-primary transition-colors hover:bg-accent-hover disabled:opacity-50"
									>
										{loading() ? "Logging in…" : "Log in with password"}
									</button>
								</form>
							</Show>

							<Show when={error()}>
								<p class="rounded bg-danger-bg/50 px-3 py-2 text-sm text-danger-text-bright">
									{error()}
								</p>
							</Show>
						</div>
					</Match>
				</Switch>
			</div>
		</div>
	);
};

export { LoginPage };
