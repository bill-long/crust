import { basePrefix, stripBasePath } from "./basePath";

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
 * Reads `location` directly rather than the router, so it does NOT react to a
 * client-side navigation. That holds because the overlay is its own window,
 * loaded straight at `/overlay` and never navigated away from - callers that
 * might run across a route change need the router's location instead.
 *
 * Both windows load the same bundle, so anything mounted at the App root —
 * outside the `<Router>` — renders in both. App-level chrome that assumes a
 * full window must opt out here: the overlay is 320x420, transparent, floating
 * over a game, and can be click-through, which would make a card visible but
 * its buttons dead.
 */
export function isOverlayWindow(): boolean {
	if (typeof window === "undefined") return false;
	// Exact match on the base-relative path, via the same helper the router
	// uses. A suffix match also matched `/settings/overlay` - reachable, since
	// `/settings/*` is a splat route - which would make the MAIN window believe
	// it was the overlay and hide both update cards for the rest of the session.
	const path = stripBasePath(window.location.pathname, basePrefix).replace(
		/\/$/,
		"",
	);
	return path === "/overlay";
}
