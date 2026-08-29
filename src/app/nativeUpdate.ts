import { createSignal } from "solid-js";
import { endActiveCall } from "../features/room/call/rtc/endCall";
import { reportError } from "../lib/reportError";
import { isNativeShell, isOverlayWindow } from "./nativeShell";
import {
	invokeTauri,
	listenTauri,
	tauriIpcAvailable,
	type UnlistenTauri,
} from "./tauri";

/**
 * Desktop app updates, the native-shell counterpart to the service worker
 * update flow in `UpdatePrompt` (which only ever fires in a browser).
 *
 * The shell owns the whole mechanism: on launch it checks the update endpoint,
 * downloads any new version, verifies it against the public key compiled into
 * the app, and holds it until exit. All this module does is listen for the
 * "it's staged" event and offer a way to quit, which is what applies it — the
 * installer runs as the app exits, so a session is never interrupted.
 */

const UPDATE_READY_EVENT = "crust://update-ready";

const [pendingVersionSignal, setPendingVersion] = createSignal<string | null>(
	null,
);

/** Reactive: the version waiting to be applied, or null when none is staged. */
export function pendingUpdateVersion(): string | null {
	return pendingVersionSignal();
}

/** How long to wait for the process to actually go before re-enabling. */
const RESTART_WATCHDOG_MS = 30_000;

/**
 * Which restart attempt owns the UI state. The watchdog can retire an attempt
 * while its IPC call is still outstanding, so a late rejection from a
 * superseded attempt must not clear a newer one's flag - that re-enabled the
 * buttons mid-attempt and let a third click past the re-entry guard.
 */
let restartAttempt = 0;

const [restartingSignal, setRestarting] = createSignal(false);
const [restartErrorSignal, setRestartError] = createSignal<string | null>(null);

/**
 * Reactive: why the last restart attempt failed, for the card to show itself.
 *
 * Not a toast: NoticeToasts is mounted inside SyncGate, behind the auth guard,
 * while the update card is mounted at the App root - so on the login screen the
 * card is visible and a notice is not rendered at all, which is precisely when
 * the message matters.
 */
export function restartError(): string | null {
	return restartErrorSignal();
}

/**
 * Reactive: true from the click until the process goes away. Ending a call can
 * take up to endCall's 10s teardown cap when media is wedged, and without this
 * the card sits there looking dead and re-clickable - the same reason the
 * logout button is gated (#477).
 */
export function restartingForUpdate(): boolean {
	return restartingSignal();
}

/**
 * Start watching for a staged desktop update. Returns an unsubscribe function;
 * resolves to a no-op where there is nothing to watch, so callers need no
 * guard.
 *
 * Both the event and the one-off query are needed. The shell checks during
 * startup, so the download can finish before this webview has booted, and Tauri
 * drops an event nobody is listening for yet; the query catches that case (and
 * a webview reload). The event catches the ordinary case where the download
 * lands mid-session.
 */
export async function watchNativeUpdates(): Promise<UnlistenTauri> {
	// The overlay window mounts the same App root. See isOverlayWindow.
	if (!isNativeShell() || isOverlayWindow()) return () => {};
	let unlisten: UnlistenTauri;
	try {
		unlisten = await listenTauri<string>(UPDATE_READY_EVENT, (version) => {
			setPendingVersion(version);
			// A newer version is a fresh prompt: carrying the previous attempt's
			// failure into it would be the same stale-error bug dismiss avoids.
			setRestartError(null);
		});
	} catch (err) {
		// Nothing subscribed, so nothing to tear down. Swallowed rather than
		// rethrown: a failed subscription must not surface as an unhandled
		// rejection at mount.
		console.error("watchNativeUpdates could not subscribe", err);
		return () => {};
	}

	// Queried after subscribing, so an update staged between the two is not
	// missed. Its failure is survivable on its own: the listener is the primary
	// channel and still covers anything staged later this session, so it is kept
	// (and returned, so the caller can still unsubscribe) rather than torn down.
	try {
		const staged = await invokeTauri<string | null>("pending_update_version");
		// Only when the listener hasn't already reported one. The shell's re-check
		// loop can stage a newer version and emit while this query is in flight,
		// and this answer describes the state at the time it was SENT - applying it
		// unconditionally would name the older version on the card while the newer
		// one is what installs.
		if (staged && !pendingVersionSignal()) setPendingVersion(staged);
	} catch (err) {
		console.error("watchNativeUpdates could not read the staged version", err);
	}
	return unlisten;
}

/**
 * Quit so the staged installer can run. The shell applies the update from its
 * exit hook; Tauri's NSIS updater relaunches the app once it finishes.
 */
export async function restartForUpdate(): Promise<void> {
	if (!isNativeShell()) return;
	// Re-entry would start a second teardown and a second quit.
	if (restartingSignal()) return;
	setRestartError(null);
	setRestarting(true);
	const attempt = ++restartAttempt;
	// Armed here, before ANY await. The flag is already set, and every path
	// below can leave it set: a throw out of the teardown, or an exit request
	// whose response never comes back. Without this the card sits on
	// "Restarting…" with both buttons inert and the re-entry guard blocking
	// every retry, for the rest of the session.
	const watchdog = setTimeout(() => {
		if (attempt === restartAttempt && restartingSignal()) {
			setRestarting(false);
			setRestartError("Crust didn't quit. Try again, or quit it yourself.");
		}
	}, RESTART_WATCHDOG_MS);
	// Checked BEFORE the teardown, not just before the invoke: dropping someone
	// out of a live call and THEN reporting that the restart failed would cost
	// them the call for nothing.
	if (!tauriIpcAvailable()) {
		reportError(new Error("Tauri IPC unavailable"), {
			logLabel: "restartForUpdate",
		});
		setRestartError("Couldn't restart. Quit Crust to finish updating.");
		setRestarting(false);
		clearTimeout(watchdog);
		return;
	}
	// Quitting kills the process outright, so an active call has to be torn down
	// FIRST or its MatrixRTC withdrawal never lands - the same rule logout
	// follows (#474). Otherwise the other participants keep seeing this user in
	// the call until the membership expires, and the installer relaunches them
	// into a room they still appear to be in.
	//
	// This covers the Restart button only. Closing the window mid-call has the
	// same weakness and predates this feature (the shell exits without waiting
	// for the webview), so it belongs in the shell's exit path rather than here;
	// tracked separately.
	//
	// Wrapped, like every other caller: `endCall` swallows its own failures and
	// timeouts, but it writes `activeCallRoomId` outside them and a Solid setter
	// runs its subscribers synchronously, so a throwing subscriber surfaces here
	// (#551). Unguarded it would abort the restart before `restart_for_update`,
	// leaving the watchdog armed and the button stuck restarting while nothing
	// restarts.
	try {
		await endActiveCall();
	} catch (e) {
		reportError(e, {
			logLabel: "Failed to end the call before restarting for an update",
		});
	}
	// Nothing clears the flag on the success path: `restart_for_update` is
	// `app.exit(0)`, which only REQUESTS the exit, so the promise resolves while
	// the app is still tearing down. Clearing it there re-enabled the button
	// mid-quit and let a second click start another teardown.
	//
	// The watchdog armed above bounds it, at far longer than any real quit takes
	// so it cannot race one.
	try {
		await invokeTauri("restart_for_update");
	} catch (err) {
		clearTimeout(watchdog);
		// A newer attempt owns the state now; this one's failure is stale.
		if (attempt !== restartAttempt) return;
		// User-initiated, and nothing else signals the failure: the card just
		// sits there looking unresponsive. The staging failures above stay
		// console-only by contrast — nobody asked for those.
		reportError(err, { logLabel: "restartForUpdate" });
		setRestartError("Couldn't restart. Quit Crust to finish updating.");
		// Only on failure: a successful quit never returns here.
		setRestarting(false);
	}
}

/** Dismiss the prompt for this session. The update still applies on quit. */
export function dismissNativeUpdate(): void {
	setPendingVersion(null);
	// Cleared with the card: otherwise a newer version staged hours later
	// re-shows the prompt still carrying the previous attempt's failure.
	setRestartError(null);
}

/** Test seam: clear module state between cases. */
export function _resetNativeUpdateForTests(): void {
	setPendingVersion(null);
	setRestarting(false);
	setRestartError(null);
	// The signals are not all of it: a case that asserts the stale-attempt branch
	// would otherwise inherit this counter from an earlier one and pass or fail
	// for the wrong reason.
	restartAttempt = 0;
}
