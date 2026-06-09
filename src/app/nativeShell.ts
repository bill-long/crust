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
