/**
 * Run `body` with `window.location.pathname` overridden, restoring the ORIGINAL
 * property descriptor afterwards.
 *
 * The restore is the point. Spreading `window.location` to put it back spreads
 * the *fake* that was just installed, leaving every later test in the file with
 * a bare `{ pathname }` object and no `href`, `origin`, or `assign` - a bug that
 * hides until some unrelated test happens to touch one of them.
 *
 * Shared because two suites (`nativeUpdate`, `UpdatePrompt`) both need it to
 * exercise the `/overlay` route, and a duplicated copy is exactly the one that
 * drifts back to the broken restore.
 */
export function withPathname(pathname: string, body: () => void): void {
	const original = Object.getOwnPropertyDescriptor(window, "location");
	Object.defineProperty(window, "location", {
		value: { ...window.location, pathname },
		writable: true,
		configurable: true,
	});
	try {
		body();
	} finally {
		if (original) Object.defineProperty(window, "location", original);
		else delete (window as { location?: unknown }).location;
	}
}
