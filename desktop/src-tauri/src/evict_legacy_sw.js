// Crust desktop shell: evict a legacy precaching service worker.
//
// Runs in every webview the shell creates, before the page's own scripts,
// whatever served the page (a plugin initialization script, see lib.rs).
// WebView2 never completes a service-worker update check for the
// asset-protocol origin, so the precaching worker that builds before the fix
// for #481 registered here keeps serving ITS build's app shell on every launch
// - and that shell is the one that does not know to unregister it, so nothing
// in the web bundle can reach such a page. This script can.
//
// The worker the current build registers carries `native=1` in its script URL
// (src/lib/nativeServiceWorker.ts - the parameter name is locked to this file
// by a test there), so any registration on this origin whose script URL lacks
// it is a worker of the browser build: the legacy one, or one the legacy page's
// own bundle manages to register before the reload below lands. Unregister
// those, drop every cache (the stale precache is what served the old shell;
// the current worker opens none), and reload so this load comes from the exe.
// The current build's worker is never touched. A launch that finds only it and
// no caches does nothing; one that finds only it plus caches (a precache that
// worker left behind in the race above) just deletes the caches, no reload.
//
// Only on the app's own origin. An initialization script runs in every
// document this webview loads, and the webview does leave the app origin - the
// OIDC login navigates it to the identity provider - so without this guard a
// third-party site's workers and caches would be wiped and the page reloaded
// mid-flow. Tauri serves the app from `tauri://localhost` (macOS/Linux) or
// `http(s)://tauri.localhost` (Windows/Android).
(async () => {
	const appOrigin =
		location.protocol === "tauri:" || location.hostname === "tauri.localhost";
	if (!appOrigin) return;
	if (!("serviceWorker" in navigator) || typeof caches === "undefined") return;
	try {
		const isNativeWorker = (worker) =>
			!!worker && new URL(worker.scriptURL).searchParams.has("native");
		const legacy = (await navigator.serviceWorker.getRegistrations()).filter(
			(registration) =>
				!isNativeWorker(
					registration.active ?? registration.waiting ?? registration.installing,
				),
		);
		const cacheKeys = await caches.keys();
		if (legacy.length === 0) {
			await Promise.all(cacheKeys.map((key) => caches.delete(key)));
			return;
		}
		await Promise.all(legacy.map((registration) => registration.unregister()));
		await Promise.all(cacheKeys.map((key) => caches.delete(key)));
		location.reload();
	} catch (e) {
		console.warn("[crust] legacy service worker eviction failed", e);
	}
})();
