/**
 * Strip the configured Vite base path from a full URL pathname so the
 * remainder can be matched against route patterns the app defines.
 *
 * Solid-router's `useLocation().pathname` returns the full pathname
 * including any base prefix (e.g. `/crust/settings/account` when the
 * app is hosted at `/crust/`), but `<Route path="/settings/*">` patterns
 * are written relative to base. Anything that does its own
 * `pathname` matching (`startsWith`, `split`) needs to strip the prefix
 * first or it breaks under sub-path hosting.
 *
 * @param pathname  Full pathname from `useLocation().pathname`.
 * @param basePrefix Base path without a trailing slash, as produced by
 *                   `import.meta.env.BASE_URL.replace(/\/$/, "")`.
 *                   `""` for root-hosted apps.
 * @returns Pathname relative to base (always starts with `/`).
 */
/**
 * The app's configured base path without a trailing slash, from Vite's
 * `BASE_URL` (overridable via `VITE_BASE_PATH`). `""` for a root-hosted app.
 * This is the single source of truth for the base - pass it to `<Router base>`
 * and `stripBasePath` so the two never diverge.
 */
export const basePrefix = import.meta.env.BASE_URL.replace(/\/$/, "");

export function stripBasePath(pathname: string, basePrefix: string): string {
	if (!basePrefix) return pathname;
	if (pathname === basePrefix) return "/";
	if (pathname.startsWith(`${basePrefix}/`)) {
		return pathname.slice(basePrefix.length);
	}
	return pathname;
}
