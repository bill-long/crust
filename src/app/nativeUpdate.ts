import { createSignal } from "solid-js";
import { isNativeShell } from "./nativeShell";
import { invokeTauri, listenTauri, type UnlistenTauri } from "./tauri";

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

/**
 * Start listening for a staged desktop update. Returns an unsubscribe function;
 * resolves to a no-op outside the native shell, so callers need no guard.
 */
export async function watchNativeUpdates(): Promise<UnlistenTauri> {
	if (!isNativeShell()) return () => {};
	return listenTauri<string>(UPDATE_READY_EVENT, (version) => {
		setPendingVersion(version);
	});
}

/**
 * Quit so the staged installer can run. The shell applies the update from its
 * exit hook; Tauri's NSIS updater relaunches the app once it finishes.
 */
export async function restartForUpdate(): Promise<void> {
	if (!isNativeShell()) return;
	try {
		await invokeTauri("restart_for_update");
	} catch (err) {
		console.error("restartForUpdate failed", err);
	}
}

/** Dismiss the prompt for this session. The update still applies on quit. */
export function dismissNativeUpdate(): void {
	setPendingVersion(null);
}

/** Test seam: clear module state between cases. */
export function _resetNativeUpdateForTests(): void {
	setPendingVersion(null);
}
