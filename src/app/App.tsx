import type { RouteSectionProps } from "@solidjs/router";
import { Route, Router, useNavigate } from "@solidjs/router";
import { type Component, Match, onMount, Show, Switch } from "solid-js";
import { ClientProvider, useClient } from "../client/client";
import LoginPage from "../features/auth/LoginPage";
import { loadSession } from "../stores/session";
import { ConfigProvider } from "./ConfigProvider";
import Layout from "./Layout";

/** Auth guard — redirects to /login if no session, otherwise boots the Matrix client. */
const AuthGuard: Component<RouteSectionProps> = (props) => {
	const session = loadSession();
	const navigate = useNavigate();

	onMount(() => {
		if (!session) {
			navigate("/login", { replace: true });
		}
	});

	if (!session) return null;

	return <ClientProvider session={session}>{props.children}</ClientProvider>;
};

/** Loading gate — shows spinner until initial sync completes. */
const SyncGate: Component<RouteSectionProps> = (props) => {
	const { syncState, cryptoState } = useClient();

	return (
		<Switch>
			<Match when={syncState() === "initial"}>
				<div class="flex h-screen items-center justify-center bg-neutral-950">
					<div class="text-center">
						<div class="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-pink-500" />
						<p class="text-neutral-400">
							{cryptoState() === "loading"
								? "Initializing encryption…"
								: "Syncing…"}
						</p>
					</div>
				</div>
			</Match>
			<Match when={syncState() === "error"}>
				<div class="flex h-screen items-center justify-center bg-neutral-950">
					<div class="text-center">
						<p class="text-red-400">Sync error</p>
						<p class="mt-1 text-sm text-neutral-500">
							Check your connection and try refreshing.
						</p>
					</div>
				</div>
			</Match>
			<Match when={true}>
				<Show when={cryptoState() === "error"}>
					<div class="border-b border-amber-800 bg-amber-950/50 px-4 py-2 text-center text-sm text-amber-300">
						Encryption initialization failed — encrypted messages may not be
						readable.
					</div>
				</Show>
				{props.children}
			</Match>
		</Switch>
	);
};

const HomePage: Component = () => <Layout />;

const App: Component = () => {
	return (
		<ConfigProvider>
			<Router>
				<Route path="/login" component={LoginPage} />
				<Route path="/" component={AuthGuard}>
					<Route path="/" component={SyncGate}>
						<Route path="/" component={HomePage} />
						<Route path="/home/:roomId?" component={HomePage} />
						<Route path="/space/:spaceId/:roomId?" component={HomePage} />
						<Route path="/dm/:roomId" component={HomePage} />
						<Route path="/settings/*" component={HomePage} />
					</Route>
				</Route>
			</Router>
		</ConfigProvider>
	);
};

export default App;
