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
// The worker the current build registers runs in "native" mode and opens no
// cache at all (src/sw.ts keeps every cache-backed route in one browser-only
// block), so a workbox precache on this origin is a reliable legacy marker:
// unregister everything, drop the caches, and reload so this load comes from
// the exe. Every later launch sees no precache and does nothing. The marker is
// deliberately the cache rather than the worker URL: it needs no knowledge of
// how the current build names its worker, and it is the precache itself that
// does the damage.
//
// Only on the app's own origin. An initialization script runs in every
// document this webview loads, and the webview does leave the app origin - the
// OIDC login navigates it to the identity provider - so without this guard a
// third-party site that happens to use Workbox would lose its workers and
// caches and be reloaded mid-flow. Tauri serves the app from `tauri://localhost`
// (macOS/Linux) or `http(s)://tauri.localhost` (Windows/Android).
(async () => {
  const appOrigin =
    location.protocol === "tauri:" || location.hostname === "tauri.localhost";
  if (!appOrigin) return;
  if (!("serviceWorker" in navigator) || typeof caches === "undefined") return;
  try {
    const keys = await caches.keys();
    if (!keys.some((key) => key.startsWith("workbox-precache"))) return;
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    await Promise.all(keys.map((key) => caches.delete(key)));
    location.reload();
  } catch (e) {
    console.warn("[crust] legacy service worker eviction failed", e);
  }
})();
