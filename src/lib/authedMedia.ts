/**
 * Authenticated media (MSC3916) support, shared between the page and the
 * service worker.
 *
 * Homeservers that enforce authenticated media (e.g. matrix.org for media
 * uploaded after its MSC3916 rollout) refuse unauthenticated
 * `/_matrix/media/v3/*` requests with a 404 and serve that media only from
 * the authenticated `/_matrix/client/v1/media/*` endpoints. A bare `<img>`
 * tag cannot send an Authorization header, so — like Element Web — Crust's
 * service worker transparently upgrades those requests: it rewrites the URL
 * to client/v1 and attaches the access token (see src/sw.ts).
 *
 * This module holds the shared decision logic (DOM/worker-free, so it is
 * unit-testable from either side) plus the page-side messaging used to keep
 * the worker's copy of the access token fresh.
 */

/** Message type the page posts to the service worker to set/clear media auth. */
export const MEDIA_AUTH_MESSAGE = "crust:media-auth";
/** Message type the service worker posts to a client to ask for media auth. */
export const MEDIA_AUTH_REQUEST = "crust:media-auth-request";

export interface MediaAuth {
	accessToken: string;
	/** Session homeserver URL (client baseUrl). Only its origin is used. */
	homeserverUrl: string;
}

const MEDIA_V3_PREFIXES = [
	"/_matrix/media/v3/download",
	"/_matrix/media/v3/thumbnail",
] as const;

/** True when a request path is an unauthenticated media endpoint the SW
 *  should consider upgrading. Exact-prefix match so `/download` and
 *  `/download/<server>/<id>[/<fileName>]` both qualify, but siblings like
 *  `/_matrix/media/v3/config` (no auth requirement) do not. */
export function isMediaV3Path(pathname: string): boolean {
	return MEDIA_V3_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

/**
 * Rewrite an unauthenticated media/v3 URL to its authenticated client/v1
 * equivalent, preserving the query string. Returns null when the URL is not
 * a media/v3 URL on the homeserver's own origin — the worker must never
 * attach the access token to a request to a different origin.
 */
export function toAuthedMediaUrl(
	rawUrl: string,
	homeserverUrl: string,
): string | null {
	let url: URL;
	let homeserver: URL;
	try {
		url = new URL(rawUrl);
		homeserver = new URL(homeserverUrl);
	} catch {
		return null;
	}
	if (url.origin !== homeserver.origin) return null;
	if (!isMediaV3Path(url.pathname)) return null;
	url.pathname = url.pathname.replace(
		/^\/_matrix\/media\/v3\//,
		"/_matrix/client/v1/media/",
	);
	return url.href;
}

/**
 * Whether a `/versions` response indicates MSC3916 authenticated media
 * support. The `/_matrix/client/v1/media/*` endpoints ship in spec v1.11.
 * Anything unexpected (missing/invalid `versions`) means "no" so the worker
 * falls back to the original unauthenticated request.
 */
export function supportsAuthedMedia(versionsResponse: unknown): boolean {
	if (typeof versionsResponse !== "object" || versionsResponse === null) {
		return false;
	}
	const versions = (versionsResponse as { versions?: unknown }).versions;
	return Array.isArray(versions) && versions.includes("v1.11");
}

function postToActiveWorker(
	auth: MediaAuth | null,
	target: ServiceWorker | null,
	responseKey?: string,
): void {
	target?.postMessage({
		type: MEDIA_AUTH_MESSAGE,
		responseKey,
		accessToken: auth?.accessToken ?? null,
		homeserverUrl: auth?.homeserverUrl ?? null,
	});
}

/**
 * Push the current media auth to the controlling service worker
 * (best-effort). Called on every session write — login, OIDC token
 * rotation, logout — so the worker's copy tracks the freshest access token
 * and is cleared on logout. No-ops when the page isn't controlled yet; the
 * worker's pull (MEDIA_AUTH_REQUEST) and the `ready` re-push in
 * {@link initMediaAuthSw} cover that gap.
 */
export function pushMediaAuthToSw(auth: MediaAuth | null): void {
	try {
		if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
			return;
		}
		postToActiveWorker(auth, navigator.serviceWorker.controller);
	} catch {
		// best-effort; the pull path recovers anything a missed push would have
	}
}

/**
 * Answer service-worker media-auth pulls with the current session, and
 * re-push once an active worker exists (covers the window before the worker
 * controls the page, where {@link pushMediaAuthToSw} is a no-op). `getAuth`
 * reads the current session at reply time so a rotated or cleared token is
 * never served stale. Call once at app startup.
 */
export function initMediaAuthSw(getAuth: () => MediaAuth | null): void {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
		return;
	}
	navigator.serviceWorker.addEventListener("message", (event) => {
		const data = event.data as { type?: string; responseKey?: unknown } | null;
		if (data?.type !== MEDIA_AUTH_REQUEST) return;
		if (typeof data.responseKey !== "string") return;
		postToActiveWorker(
			getAuth(),
			navigator.serviceWorker.controller,
			data.responseKey,
		);
	});
	navigator.serviceWorker.ready
		.then((registration) => {
			postToActiveWorker(getAuth(), registration.active);
		})
		.catch(() => {
			// best-effort; per-request pulls still cover a missed ready push
		});
}
