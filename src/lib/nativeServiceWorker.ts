/**
 * The desktop shell's service-worker registration, shared by the page (which
 * registers the worker, see src/app/UpdatePrompt.tsx) and the worker itself
 * (which reads its mode back out of its own script URL, see src/sw.ts).
 *
 * Why the shell registers a different worker URL than the browser build does
 * (issue #481): WebView2 never completes a service-worker UPDATE check for an
 * origin served by Tauri's asset protocol - `registration.update()` fails with
 * "An unknown error occurred when fetching the script", because the
 * browser-side script fetch bypasses the protocol handler - while a fresh
 * registration installs fine. So whatever worker is registered first controls
 * the origin forever, and a precaching worker keeps serving the app shell of
 * the build that registered it, across app updates, against an exe whose
 * hashed assets have moved on. That is exactly how #481 happened: the stale
 * shell requested a crypto wasm the new exe no longer had, got index.html back,
 * and crypto never initialized. Two things follow, both carried by this URL:
 *
 *   - `native`: the worker must not precache or serve the app shell at all.
 *     The exe serves every asset itself, always current, so a precache can only
 *     ever be equal or stale. The worker keeps only the duties the page cannot
 *     do without one (authenticated media, see src/sw.ts).
 *   - `build`: the worker is registered under a URL that carries a digest of
 *     its own script. A new script URL on the same scope is a NEW registration
 *     to the browser, which WebView2 does fetch, so the shell's worker tracks
 *     the installed build even though an update of a fixed URL never would.
 *     Deriving the id from the script's content (rather than baking a build
 *     stamp into the bundle) keeps the web build reproducible - identical
 *     sources still produce identical chunk hashes, so browser users are not
 *     offered an "update" for a rebuild of the same commit - and re-registers
 *     exactly when the worker actually changed.
 */

/** Query parameter marking a worker registered by the desktop shell. */
export const NATIVE_SW_MODE_PARAM = "native";
/** Query parameter carrying the digest of the worker script registered. */
export const NATIVE_SW_BUILD_PARAM = "build";

/**
 * The script URL the desktop shell registers:
 * `<base>sw.js?native=1&build=<digest>`. `base` is the app's base path
 * (`import.meta.env.BASE_URL`, "/" or e.g. "/crust/"), so the registration gets
 * the same default scope as the browser build's worker.
 */
export function nativeServiceWorkerUrl(base: string, digest: string): string {
	const params = new URLSearchParams({
		[NATIVE_SW_MODE_PARAM]: "1",
		[NATIVE_SW_BUILD_PARAM]: digest,
	});
	return `${base}sw.js?${params}`;
}

/**
 * The worker identity the shell registers under: SHA-256 of the worker script
 * as served (hex). Any digest that changes when the script changes would do;
 * SHA-256 is what every secure context has in `crypto.subtle`.
 */
export async function digestServiceWorkerScript(
	script: string,
): Promise<string> {
	const bytes = new TextEncoder().encode(script);
	const hash = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(hash), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * Whether a worker script URL (`self.location.href` inside the worker) is one
 * the desktop shell registered.
 */
export function isNativeServiceWorkerUrl(scriptUrl: string): boolean {
	try {
		return new URL(scriptUrl).searchParams.has(NATIVE_SW_MODE_PARAM);
	} catch {
		return false;
	}
}
