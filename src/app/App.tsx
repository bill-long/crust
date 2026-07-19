import type { RouteSectionProps } from "@solidjs/router";
import { Route, Router, useLocation, useNavigate } from "@solidjs/router";
import {
	type Component,
	createEffect,
	lazy,
	Match,
	onMount,
	Show,
	Suspense,
	Switch,
} from "solid-js";
import { ClientProvider, useClient } from "../client/client";
import { clearCryptoStores } from "../client/cryptoRecovery";
import { NoticeToasts } from "../components/NoticeToasts";
import { toReturnToPath } from "../features/auth/returnTo";
import { CryptoStatusBanner } from "../features/crypto/CryptoStatusBanner";
import { PersistentCallSurface } from "../features/room/call/rtc/PersistentCallSurface";
import { closeNotificationSound } from "../features/room/notificationSound";
import { setActiveCallRoomId } from "../stores/activeCall";
import { clearSession, loadSession } from "../stores/session";
import { basePrefix } from "./basePath";
import { ConfigProvider } from "./ConfigProvider";
import { Layout } from "./Layout";
import { UpdatePrompt } from "./UpdatePrompt";
import { useDecodedParams } from "./useDecodedParams";

// Route-level code splitting (#307): the login page and the desktop
// call-overlay window contents are self-contained routes that most sessions
// never render, so they load on demand instead of inflating the initial
// bundle. Suspense fallback is null for /overlay (the desktop overlay window
// paints its own background) and a full-viewport surface for /login so the
// background never flashes while the chunk loads.
//
// Prefetch (#414): /login is the destination for EVERY unauthenticated
// visit, so kicking off the module request at app startup overlaps the
// chunk fetch with entry-chunk evaluation + router mount instead of
// starting it only when Suspense first asks. The browser module map
// dedupes: lazy()'s import() below resolves to the same in-flight module,
// so this costs nothing for authenticated sessions beyond one cheap
// parallel request that the service worker would precache anyway.
// The rejection is swallowed deliberately: this is an optimization, not
// the load path. If the prefetch fetch fails (transient network/CDN),
// lazy()'s import() re-attempts on demand and the Suspense fallback
// covers the gap — an unhandled rejection here would only be noise in
// global error reporting.
import("../features/auth/LoginPage").catch(() => {});
const LoginPage = lazy(() =>
	import("../features/auth/LoginPage").then((m) => ({ default: m.LoginPage })),
);
const OverlayRoute = lazy(() =>
	import("../features/room/call/rtc/OverlayRoute").then((m) => ({
		default: m.OverlayRoute,
	})),
);

/** Auth guard — redirects to /login if no session, otherwise boots the Matrix client. */
const AuthGuard: Component<RouteSectionProps> = (props) => {
	const session = loadSession();
	const navigate = useNavigate();
	const location = useLocation();

	onMount(() => {
		if (!session) {
			// Preserve the deep-linked target so login can return the user to it
			// instead of dropping them on home (#338). Carried via router state
			// (not a query param), which a crafted link can't set. Base-relative
			// (toReturnToPath strips the Vite base) so navigate() re-adds it
			// without doubling it under sub-path hosting.
			navigate("/login", {
				replace: true,
				state: { returnTo: toReturnToPath(location, basePrefix) },
			});
		}
	});

	if (!session) return null;

	return <ClientProvider session={session}>{props.children}</ClientProvider>;
};

/** Loading gate — shows spinner until initial sync completes. */
const SyncGate: Component<RouteSectionProps> = (props) => {
	const { syncState, cryptoState, client } = useClient();
	const navigate = useNavigate();
	const location = useLocation();
	const params = useDecodedParams<{ roomId?: string }>();

	const openDeviceSettings = (): void => {
		navigate("/settings/devices", {
			state: {
				returnTo: location.pathname + location.search + location.hash,
				activeRoomId: params.roomId,
			},
		});
	};

	// Auto-redirect to login when session is expired
	let cleaningUp = false;
	createEffect(() => {
		if (syncState() === "logged-out" && !cleaningUp) {
			cleaningUp = true;
			// Tear down any active call surface so the controller unmounts
			// and its onCleanup chain runs. The client is already stopped
			// by `onSessionLoggedOut` (per the comment below), so any
			// in-flight `leaveRoomSession` will no-op — but we still need
			// to drop the global signal so a stale mini-widget / overlay
			// never outlives the session.
			setActiveCallRoomId(null);
			closeNotificationSound();
			// Client is already stopped by onSessionLoggedOut handler
			// (stopClient runs before setSyncState triggers this effect).
			// Clear stores (best-effort async) then redirect.
			clearCryptoStores(client)
				.catch((e: unknown) => {
					console.warn("Failed to clear stores on session expiry:", e);
				})
				.finally(() => {
					clearSession();
					navigate("/login", { replace: true });
				});
		}
	});

	const handleForceLogout = async (): Promise<void> => {
		// Tear down any active call BEFORE stopping the client so the
		// controller's onCleanup runs against a still-alive client (the
		// same ordering `Layout.handleLogout` uses — see rubber-duck #2
		// on Phase 7B). Without this the mini-widget / overlay could
		// briefly point at a session whose underlying client is stopped.
		setActiveCallRoomId(null);
		closeNotificationSound();
		client.stopClient();
		// Clear session and navigate immediately so the user never sees
		// the main app UI in the "stopped" state while clearStores() awaits.
		clearSession();
		navigate("/login", { replace: true });
		try {
			await clearCryptoStores(client);
		} catch {
			// best-effort
		}
	};

	return (
		<>
			<Switch>
				<Match when={syncState() === "initial"}>
					<div class="flex h-full items-center justify-center bg-surface-0">
						<div class="text-center">
							<div class="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							<p class="text-text-muted">
								{cryptoState() === "loading"
									? "Initializing encryption…"
									: "Syncing…"}
							</p>
						</div>
					</div>
				</Match>
				<Match when={syncState() === "error"}>
					<div class="flex h-full items-center justify-center bg-surface-0">
						<div class="text-center">
							<p class="text-danger-text">Sync error</p>
							<p class="mt-1 text-sm text-text-disabled">
								Check your connection and try refreshing.
							</p>
							<button
								type="button"
								onClick={handleForceLogout}
								class="mt-4 rounded-lg bg-surface-3 px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-4 hover:text-text-primary"
							>
								Log out
							</button>
						</div>
					</div>
				</Match>
				<Match when={syncState() === "logged-out"}>
					<div class="flex h-full items-center justify-center bg-surface-0">
						<div class="text-center">
							<p class="text-text-muted">Session expired, redirecting…</p>
						</div>
					</div>
				</Match>
				<Match when={true}>
					<div class="flex h-full flex-col bg-surface-0 text-text-primary">
						<Show when={cryptoState() === "error"}>
							<button
								type="button"
								onClick={openDeviceSettings}
								class="shrink-0 border-b border-warning-border bg-warning-bg/50 px-4 py-2 text-center text-sm text-warning-text transition-colors hover:bg-warning-bg/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning-border focus-visible:ring-inset"
								aria-label="Encryption initialization failed. Open Devices & Security settings."
							>
								Encryption initialization failed — encrypted messages may not be
								readable. <span class="underline">Open settings →</span>
							</button>
						</Show>
						<CryptoStatusBanner />
						<div class="flex min-h-0 flex-1 flex-col">{props.children}</div>
					</div>
				</Match>
			</Switch>
			{/* Mounted as a sibling of <Switch> (and of the per-route
				children) so the call-session lifecycle owner survives BOTH
				sub-route shape changes (e.g. mini-widget "Return" flipping
				/space/X/Y -> /home/Y) AND transient sync-state transitions.
				Renders nothing until activeCallRoomId() becomes non-null. */}
			<PersistentCallSurface />
			{/* App-root transient notices (toasts). A sibling of <Switch> so a
				notice survives room/route changes and a disposed emitter. */}
			<NoticeToasts />
		</>
	);
};

const HomePage: Component = () => <Layout />;

const App: Component = () => {
	// `BASE_URL` is set by Vite from the `base` config option (default `/`,
	// overridable via `VITE_BASE_PATH` at build time). The router wants the
	// base without a trailing slash; "/" becomes "" which the router treats
	// as root-hosted (see basePrefix in basePath.ts - the shared source of truth).
	return (
		<ConfigProvider>
			<Router base={basePrefix}>
				<Route
					path="/login"
					component={() => (
						// Full-viewport fallback in the page background color: the
						// login chunk is small and local, so this paints once and
						// swaps to the form with no visible shift.
						<Suspense fallback={<div class="h-full bg-surface-0" />}>
							<LoginPage />
						</Suspense>
					)}
				/>
				{/* Standalone overlay window contents (the desktop two-window
				    overlay). Top-level + session-free: it mirrors call state from
				    the main window over a BroadcastChannel rather than booting a
				    client of its own. */}
				<Route
					path="/overlay"
					component={() => (
						<Suspense fallback={null}>
							<OverlayRoute />
						</Suspense>
					)}
				/>
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
			<UpdatePrompt />
		</ConfigProvider>
	);
};

export { App };
