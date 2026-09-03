/**
 * Whether an error from a Client-Server request means the homeserver does not
 * implement that endpoint, as opposed to could not serve it right now.
 *
 * An errcode, never a bare status. A server that genuinely lacks an endpoint
 * says so in the body: `M_UNRECOGNIZED` from one that never had it,
 * `M_NOT_FOUND` from one that answers spec-shaped for a missing route. A 404
 * with no Matrix error body is a proxy default vhost, a CDN maintenance page
 * or an ingress mid-restart - and because callers latch this answer for the
 * session, one unlucky request in that window would otherwise switch the
 * feature off until the page was reloaded. Everything else (timeouts, 5xx,
 * rate limits, network errors) is transient and says nothing about support.
 *
 * Shared by every feature that probes an optional endpoint and remembers the
 * answer (`/search`, MSC4519 `/rtc/transports`), so the rule is written once.
 */
export function meansEndpointUnsupported(e: unknown): boolean {
	const err = e as { errcode?: unknown } | null;
	return err?.errcode === "M_UNRECOGNIZED" || err?.errcode === "M_NOT_FOUND";
}
