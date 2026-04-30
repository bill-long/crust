import { useNavigate } from "@solidjs/router";
import {
	createClient,
	type ILoginFlowsResponse,
	type LoginResponse,
} from "matrix-js-sdk";
import { type Component, createSignal, Match, Show, Switch } from "solid-js";
import { useConfig } from "../../app/ConfigProvider";
import { saveSession } from "../../stores/session";
import { discoverHomeserver } from "./discovery";

const LoginPage: Component = () => {
	const config = useConfig();
	const navigate = useNavigate();

	const [homeserver, setHomeserver] = createSignal(config.defaultHomeserver);
	const [username, setUsername] = createSignal("");
	const [password, setPassword] = createSignal("");
	const [error, setError] = createSignal("");
	const [loading, setLoading] = createSignal(false);

	const handleSubmit = async (e: Event): Promise<void> => {
		e.preventDefault();
		setError("");
		setLoading(true);

		try {
			// Discover homeserver base URL
			const baseUrl = await discoverHomeserver(homeserver());

			// Create a temporary unauthenticated client
			const tempClient = createClient({ baseUrl });

			// Check login flows — reject SSO-only servers
			let flows: ILoginFlowsResponse;
			try {
				flows = await tempClient.loginFlows();
			} catch {
				throw new Error(
					"Could not contact the homeserver. Check the server address.",
				);
			}

			const hasPassword = flows.flows.some(
				(f) => f.type === "m.login.password",
			);
			if (!hasPassword) {
				const hasSSO = flows.flows.some(
					(f) => f.type === "m.login.sso" || f.type === "m.login.cas",
				);
				if (hasSSO) {
					throw new Error(
						"This server requires SSO login, which Crust doesn't support yet.",
					);
				}
				throw new Error("This server doesn't support password login.");
			}

			// Login via the non-deprecated loginRequest API
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
				const msg = err instanceof Error ? err.message : "Login failed";
				throw new Error(msg);
			}

			// Prefer well_known from the login response for the persisted URL
			let resolvedUrl = baseUrl;
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

			// Persist session
			saveSession({
				accessToken: response.access_token,
				userId: response.user_id,
				deviceId: response.device_id,
				homeserverUrl: resolvedUrl,
			});

			navigate("/", { replace: true });
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : "Login failed");
		} finally {
			setLoading(false);
		}
	};

	return (
		<div class="flex min-h-screen items-center justify-center bg-neutral-950 p-4">
			<div class="w-full max-w-sm">
				<h1 class="mb-8 text-center text-3xl font-bold text-white">Crust</h1>
				<form onSubmit={handleSubmit} class="space-y-4">
					<div>
						<label for="homeserver" class="mb-1 block text-sm text-neutral-400">
							Homeserver
						</label>
						<input
							id="homeserver"
							type="text"
							value={homeserver()}
							onInput={(e) => setHomeserver(e.currentTarget.value)}
							placeholder="no.strange.pizza"
							class="w-full rounded bg-neutral-800 px-3 py-2 text-white placeholder-neutral-500 outline-none focus:ring-2 focus:ring-pink-500"
							required
						/>
					</div>
					<div>
						<label for="username" class="mb-1 block text-sm text-neutral-400">
							Username
						</label>
						<input
							id="username"
							type="text"
							value={username()}
							onInput={(e) => setUsername(e.currentTarget.value)}
							placeholder="username"
							autocomplete="username"
							class="w-full rounded bg-neutral-800 px-3 py-2 text-white placeholder-neutral-500 outline-none focus:ring-2 focus:ring-pink-500"
							required
						/>
					</div>
					<div>
						<label for="password" class="mb-1 block text-sm text-neutral-400">
							Password
						</label>
						<input
							id="password"
							type="password"
							value={password()}
							onInput={(e) => setPassword(e.currentTarget.value)}
							placeholder="••••••••"
							autocomplete="current-password"
							class="w-full rounded bg-neutral-800 px-3 py-2 text-white placeholder-neutral-500 outline-none focus:ring-2 focus:ring-pink-500"
							required
						/>
					</div>

					<Show when={error()}>
						<p class="rounded bg-red-900/50 px-3 py-2 text-sm text-red-300">
							{error()}
						</p>
					</Show>

					<button
						type="submit"
						disabled={loading()}
						class="w-full rounded bg-pink-600 py-2 font-semibold text-white transition-colors hover:bg-pink-500 disabled:opacity-50"
					>
						<Switch>
							<Match when={loading()}>Logging in…</Match>
							<Match when={!loading()}>Log in</Match>
						</Switch>
					</button>
				</form>
			</div>
		</div>
	);
};

export default LoginPage;
