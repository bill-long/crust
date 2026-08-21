/**
 * Detection for "are we running inside the native desktop shell" (the Tauri
 * wrapper, as opposed to a plain browser tab or the installed PWA).
 *
 * Tauri 2 injects `window.isTauri === true` into every webview it owns, so this
 * is a cheap, synchronous, dependency-free check. It lets the same web bundle
 * behave differently when hosted by the desktop overlay shell — e.g. the
 * `/overlay` route renders against a transparent background (the chromeless
 * native window shows the game behind it) instead of an opaque preview.
 */
export function isNativeShell(): boolean {
	return (
		typeof window !== "undefined" &&
		(window as { isTauri?: boolean }).isTauri === true
	);
}

/**
 * True in the chromeless overlay window specifically (the second Tauri window,
 * on the `/overlay` route) rather than the main app window.
 *
 * Both windows load the same bundle, so anything mounted at the App root —
 * outside the `<Router>` — renders in both. App-level chrome that assumes a
 * full window must opt out here: the overlay is 320x420, transparent, floating
 * over a game, and can be click-through, which would make a card visible but
 * its buttons dead. Matched on the path suffix so a base prefix (the web app is
 * served under /crust/) does not change the answer.
 */
export function isOverlayWindow(): boolean {
	return (
		typeof window !== "undefined" &&
		window.location.pathname.replace(/\/$/, "").endsWith("/overlay")
	);
}
