import { stripBasePath } from "../../app/basePath";

/**
 * Build a base-relative "returnTo" path from the current location.
 *
 * `useLocation().pathname` includes the Vite base (e.g. `/crust/home/!room`
 * under sub-path hosting), but `navigate()` re-prepends the base to an
 * absolute path. Storing the base-included pathname and navigating to it would
 * double the base (`/crust/crust/home/...`) and match no route. Strip the base
 * here so the stored target is what `navigate()` expects.
 */
export function toReturnToPath(
	location: { pathname: string; search: string; hash: string },
	basePrefix: string,
): string {
	return (
		stripBasePath(location.pathname, basePrefix) +
		location.search +
		location.hash
	);
}

/** True if the string contains an ASCII control char (0x00-0x1f or 0x7f). */
function hasControlChar(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c <= 0x1f || c === 0x7f) return true;
	}
	return false;
}

/**
 * Sanitize a post-login redirect target ("returnTo") to a safe, in-app path.
 *
 * The target is captured by `AuthGuard` from the location the user deep-linked
 * to while logged out and carried through login via router state. Router state
 * can't be set from a crafted link, so this is defense-in-depth - but we still
 * refuse anything that isn't an unambiguous root-relative in-app path:
 *
 *  - must start with a single "/" (a relative path within the app),
 *  - NOT "//..." (protocol-relative -> resolves to an external origin),
 *  - no backslashes (browsers can normalize "\" to "/", turning "/\evil.com"
 *    into a protocol-relative redirect),
 *  - no control chars (tab/newline/CR are stripped by browsers when resolving
 *    a URL, which could collapse "/\t/evil" into "//evil"),
 *  - not the login route itself (avoid a redirect loop back to login).
 *
 * Anything that fails these checks falls back to "/".
 */
export function sanitizeReturnTo(target: unknown): string {
	if (typeof target !== "string" || target === "") return "/";
	if (!target.startsWith("/")) return "/";
	if (target.startsWith("//")) return "/";
	if (target.includes("\\")) return "/";
	if (hasControlChar(target)) return "/";
	if (
		target === "/login" ||
		target.startsWith("/login/") ||
		target.startsWith("/login?") ||
		target.startsWith("/login#")
	) {
		return "/";
	}
	return target;
}
