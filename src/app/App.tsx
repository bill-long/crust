import type { RouteSectionProps } from "@solidjs/router";
import { Route, Router, useLocation, useNavigate } from "@solidjs/router";
import {
	type Component,
	createEffect,
	createSignal,
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
import { LoginGate } from "../features/auth/LoginGate";
import { toReturnToPath } from "../features/auth/returnTo";
import { CryptoStatusBanner } from "../features/crypto/CryptoStatusBanner";
import { PersistentCallSurface } from "../features/room/call/rtc/PersistentCallSurface";
import { closeNotificationSound } from "../features/room/notificationSound";
import { reportError } from "../lib/reportError";
import { setActiveCallRoomId } from "../stores/activeCall";
import { loadSession, loadSessions } from "../stores/session";
import { finishAccountLogout } from "./accountSwitch";
import { basePrefix } from "./basePath";
import { createBootStall } from "./bootStall";
import { ConfigProvider, useConfig } from "./ConfigProvider";
import { runForceLogout } from "./forceLogout";
import { accountTransitionInFlight, Layout } from "./Layout";
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
const LoginCallback = lazy(() =>
	import("../features/auth/LoginCallback").then((m) => ({
		default: m.LoginCallback,
	})),
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

/**
 * The way out of a boot or a sync this app cannot finish: stop the client, wipe
 * this account's stores, and leave - to a remaining account if there is one,
 * and to the login page otherwise. Offered on the sync-error screen, and on the
 * still-syncing screen once that has stalled (#551).
 */
const ForceLogoutButton: Component<{ onLogOut: () => void }> = (props) => (
	<button
		type="button"
		onClick={props.onLogOut}
		class="mt-4 rounded-lg bg-surface-3 px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-4 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-border-focus"
	>
		Log out
	</button>
);

/** Loading gate — shows spinner until initial sync completes. */
const SyncGate: Component<RouteSectionProps> = (props) => {
	const { syncState, cryptoState, client, session } = useClient();
	const pushConfig = useConfig().push;
	const navigate = useNavigate();
	const location = useLocation();
	const params = useDecodedParams<{ roomId?: string }>();
	const [forcingLogout, setForcingLogout] = createSignal(false);
	const [logoutFailed, setLogoutFailed] = createSignal(false);
	// A boot that never finishes has to offer a way out, or the only one left is
	// the one #549 closed - typing `/login`, which replaced the stored account
	// and orphaned its device. The phase this watches deliberately excludes
	// crypto initialization: that is bounded on both branches and can spend
	// minutes legitimately downloading the WASM module on a first visit, whereas
	// what follows it - `startClient` awaiting `/versions`, then the first
	// `/sync` - has no bound at all (#551).
	const bootStalled = createBootStall(
		() => syncState() === "initial" && cryptoState() !== "loading",
	);

	/** What the escape is doing, for a reader who cannot see the screen swap. */
	const escapeStatus = (): string => {
		if (logoutFailed()) {
			return "Couldn't finish logging out. Reload the app and try again.";
		}
		return forcingLogout() ? "Logging out…" : "";
	};

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
	/** Whether this document's own logout ever made this effect stand down. */
	let stoodDownForOwner = false;
	createEffect(() => {
		// `forcingLogout()` as well as the local flag: the escape below runs this
		// same tail, and its own revoke is one of the requests whose 401 lands
		// here. Two overlapping `clearCryptoStores` calls can block each other's
		// `deleteDatabase` until the bound expires, which is the hazard the
		// escape's single-flight guard exists for - and it has to hold across
		// both entry points, not just one.
		//
		// A logout started from the app itself has the same hazard: it revokes the
		// token and goes on making authed requests, and their 401 arrives here
		// while that logout is still running. That one cannot be settled by a flag
		// alone - see the two checks below.
		//
		// The escape never gives the flag back, so this stays suppressed for the
		// rest of the document's life. That is deliberate: it has taken ownership
		// of the same tail this effect would run, and if it FAILS, re-running the
		// tail that just failed is not the answer - its own failure screen, which
		// renders ahead of every state arm below, is.
		if (syncState() === "logged-out" && !cleaningUp && !forcingLogout()) {
			// Another transition in THIS document owns this session's end. Stand
			// down while it runs - the read is deliberately reactive, because what
			// happens when it releases is the whole question - and remember that we
			// did, because the answer below is only ever about our own owner.
			if (accountTransitionInFlight()) {
				stoodDownForOwner = true;
				return;
			}
			// Our owner has released: ask storage what it achieved. Gone means it
			// finished, which means it also navigated, so repeating the tail would
			// run a second `clearCryptoStores` over the first - the overlapping
			// `deleteDatabase` this guard exists to prevent - and navigate again on
			// top of it. Still listed means it FAILED, and then this cleanup is the
			// only one coming.
			//
			// Gated on having stood down at all, because storage is shared across
			// tabs and this document is not the only thing that can empty it.
			// Another tab logging the account out leaves it absent here with no
			// owner of ours ever having run - and returning on that would strand
			// this tab on the redirect notice below, which has no way out.
			if (
				stoodDownForOwner &&
				!loadSessions().some((a) => a.userId === session.userId)
			) {
				return;
			}
			cleaningUp = true;
			// Tear down any active call surface so the controller unmounts
			// and its onCleanup chain runs. The client is already stopped
			// by `onSessionLoggedOut` (per the comment below), so any
			// in-flight `leaveRoomSession` will no-op — but we still need
			// to drop the global signal so a stale mini-widget / overlay
			// never outlives the session.
			//
			// Caught, like the same write on every other exit: a Solid setter runs
			// its subscribers synchronously, and a throwing effect here would
			// abort this cleanup before `finishAccountLogout` - leaving an expired
			// session with its stores unwiped, its account still in storage, and
			// no redirect.
			try {
				setActiveCallRoomId(null);
			} catch (e) {
				reportError(e, {
					logLabel: "Failed to clear the active call on session expiry",
				});
			}
			closeNotificationSound();
			// Client is already stopped by onSessionLoggedOut handler
			// (stopClient runs before setSyncState triggers this effect).
			// Clear stores (best-effort async) then redirect.
			// Another account may still be logged in; land there rather than on a
			// login form that would replace it (#533).
			void finishAccountLogout(
				{ client, pushConfig },
				// This document's own account; another tab may have switched.
				session.userId,
				() =>
					clearCryptoStores(client, session).catch((e: unknown) => {
						console.warn("Failed to clear stores on session expiry:", e);
					}),
				() => navigate("/login", { replace: true }),
			);
		}
	});

	const handleForceLogout = async (): Promise<void> => {
		// Single-flight, for the reason `Layout.handleLogout` documents: the wipe
		// below is awaited before this screen goes away, and two overlapping
		// `clearCryptoStores` calls can block each other's `deleteDatabase`
		// indefinitely. A second CLICK cannot get here - the escape's own screen
		// replaces the button the moment the flag is set - but a second entry
		// can: `cleaningUp` counts too, because the expired-session effect above
		// runs the same tail, and a 401 from this very logout is one of the ways
		// it starts.
		if (forcingLogout() || cleaningUp) return;
		setForcingLogout(true);
		try {
			// A logout that ends in a reload keeps the guard set; this document
			// keeps running until the replacement takes over, and a second click
			// would start an overlapping `clearCryptoStores`.
			if (
				(await runForceLogout({
					client,
					pushConfig,
					session,
					goToLogin: () => navigate("/login", { replace: true }),
				})) === "reloading"
			) {
				return;
			}
		} catch (e) {
			// A narrow net on purpose, and not the only one. `runForceLogout`
			// swallows each step's own failure - that is its contract, since no
			// step may abort the ones that follow - so what reaches here is the
			// residue: a throw from something expected not to throw. The other
			// failure mode, a step that never finishes, is answered by that step's
			// own bound rather than here, which is why every one of them has one.
			//
			// Console-only: the failure screen below is the user-visible surface,
			// and a toast on top of it would be the second one (AGENTS.md).
			reportError(e, { logLabel: "Force logout failed" });
			// The guard STAYS set. The client is stopped by now, so there is no
			// app to fall back into: releasing it would drop the switch below
			// through to the full layout, against a stopped client and a
			// `summaries` store the first sync never populated. Say so instead,
			// and offer the one action left that is not destructive.
			setLogoutFailed(true);
		}
	};

	return (
		<>
			<Switch>
				{/* FIRST, ahead of every state arm. Once the escape is running it
				    owns the screen: the sync states it is invoked from do not
				    reliably change (a sync error parked on its keep-alive emits
				    nothing when the client stops, and a boot stalled on `/versions`
				    never built a sync API to emit anything at all), so an arm placed
				    below them would never be reached - and its failure state, the only
				    way out left if the escape itself fails, would be unreachable with
				    it. Placed here it also covers the state that DOES change: stopping
				    a running sync reports `Stopped`, which matches no arm below, so
				    the switch would otherwise fall through and mount the whole app -
				    against a `summaries` store the first sync never populated - for as
				    long as the wipe takes. */}
				<Match when={forcingLogout()}>
					<div class="flex h-full items-center justify-center bg-surface-0">
						<div class="text-center">
							<Show
								when={logoutFailed()}
								fallback={
									<>
										<div class="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
										<p class="text-text-muted">Logging out…</p>
									</>
								}
							>
								<p class="text-danger-text">Couldn't finish logging out</p>
								{/* A reload is the only thing left that costs nothing: the
								    client is stopped, so there is no session to return to, and
								    a fresh document retries the whole boot. */}
								<p class="mx-auto mt-1 max-w-xs text-sm text-text-disabled">
									Reload the app and try again.
								</p>
								<button
									type="button"
									onClick={() => window.location.reload()}
									class="mt-4 rounded-lg bg-surface-3 px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-4 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-border-focus"
								>
									Reload
								</button>
							</Show>
						</div>
					</div>
				</Match>
				<Match when={syncState() === "initial"}>
					<div class="flex h-full items-center justify-center bg-surface-0">
						<div class="text-center">
							<div class="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-border-default border-t-accent-hover" />
							<p class="text-text-muted">
								{cryptoState() === "loading"
									? "Initializing encryption…"
									: "Syncing…"}
							</p>
							{/* Empty and already mounted, not created with its content: a
							    live region does not announce what is inserted in the same
							    flush that creates the region (#549). */}
							<div aria-live="polite">
								<Show when={bootStalled()}>
									{/* Waiting first, and the cost of not waiting named: this
									    control is offered 30 seconds into a boot that may only be
									    slow, and it takes this device's encryption keys with it. */}
									<p class="mx-auto mt-4 max-w-xs text-sm text-text-disabled">
										This is taking longer than usual. You can keep waiting.
										Logging out signs this device out and clears its encryption
										keys.
									</p>
									<ForceLogoutButton onLogOut={handleForceLogout} />
								</Show>
							</div>
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
							<ForceLogoutButton onLogOut={handleForceLogout} />
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
								class="shrink-0 border-b border-warning-border bg-warning-bg/50 px-4 py-2 text-center text-sm text-warning-text transition-colors hover:bg-warning-bg/70 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-warning-border focus-visible:ring-inset"
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
			{/* The escape's own screens are created together with their text, and a
				live region does not announce content inserted in the same flush that
				creates it (#549) - so they cannot announce themselves. This one is
				mounted for the life of the gate and only its contents change. */}
			<div aria-live="polite" role="status" class="sr-only">
				{escapeStatus()}
			</div>
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
				{/* LoginGate turns an already-signed-in visitor away (#549);
				    everything inside it, the chunk's Suspense boundary included,
				    is only created for a visitor it lets through. */}
				<Route
					path="/login"
					component={() => (
						<LoginGate>
							{/* Full-viewport fallback in the page background color: the
							    login chunk is small and local, so this paints once and
							    swaps to the form with no visible shift. */}
							<Suspense fallback={<div class="h-full bg-surface-0" />}>
								<LoginPage />
							</Suspense>
						</LoginGate>
					)}
				/>
				{/* OIDC redirect landing (MSC3861). Outside the auth guard - the
				    whole point of the route is to CREATE the session. */}
				<Route
					path="/login/callback"
					component={() => (
						<Suspense fallback={<div class="h-full bg-surface-0" />}>
							<LoginCallback />
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
