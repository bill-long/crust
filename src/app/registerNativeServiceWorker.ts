import {
	digestServiceWorkerScript,
	nativeServiceWorkerScriptUrl,
	nativeServiceWorkerUrl,
} from "../lib/nativeServiceWorker";
import { reportError } from "../lib/reportError";
import { isNativeShell } from "./nativeShell";

/**
 * Register the desktop shell's service worker. Called once at app bootstrap
 * (src/index.tsx), next to the media-auth wiring the worker exists for; a
 * no-op outside the shell, where vite-plugin-pwa's `useRegisterSW` (in
 * src/app/UpdatePrompt.tsx) registers the browser build's worker instead.
 *
 * The worker is registered under a URL carrying a digest of the script itself
 * (see src/lib/nativeServiceWorker.ts for why the URL must change whenever the
 * worker does). The script is read from the exe: the browser build's worker
 * has no route for `sw.js`, so even a leftover legacy worker cannot answer this
 * fetch from a cache. Best-effort like the browser registration: a failure only
 * costs authenticated media in the shell, so it is logged, not surfaced.
 */
export async function registerNativeServiceWorker(): Promise<void> {
	if (!isNativeShell()) return;
	// The worker only exists in production builds (devOptions.enabled is false
	// in vite.config.ts), so a `tauri dev` session against the Vite dev server
	// has nothing to register.
	if (import.meta.env.DEV) return;
	if (!("serviceWorker" in navigator)) return;
	const base = import.meta.env.BASE_URL;
	try {
		const response = await fetch(nativeServiceWorkerScriptUrl(base), {
			cache: "no-store",
		});
		if (!response.ok) {
			throw new Error(`sw.js responded ${response.status}`);
		}
		const digest = await digestServiceWorkerScript(await response.text());
		await navigator.serviceWorker.register(
			nativeServiceWorkerUrl(base, digest),
		);
	} catch (err: unknown) {
		reportError(err, {
			logLabel: "Desktop service worker registration failed",
		});
	}
}
