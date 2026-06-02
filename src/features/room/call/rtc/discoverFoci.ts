import type { MatrixClient } from "matrix-js-sdk";
import type { LivekitTransport } from "matrix-js-sdk/lib/matrixrtc";

/**
 * Builds the EC-bundled fallback LiveKit foci list. Derives the
 * `livekit_service_url` from the operator-configured Element Call URL,
 * following EC's bundled-nginx convention of `${url}/livekit/sfu/get`
 * for the `lk-jwt-service` sidecar endpoint. Used only when the
 * homeserver does not advertise any MSC4143 foci in `.well-known/matrix/client`.
 */
export function buildFallbackLivekitFoci(
	elementCallUrl: string,
	roomId: string,
): LivekitTransport[] {
	const trimmed = elementCallUrl.trim();
	if (trimmed.length === 0) return [];
	const base = trimmed.replace(/\/+$/, "");
	return [
		{
			type: "livekit",
			livekit_service_url: `${base}/livekit/sfu/get`,
			livekit_alias: roomId,
		},
	];
}

/**
 * Extract LiveKit foci from a parsed `.well-known/matrix/client` document.
 * Validates each entry to defend against malformed server responses — the
 * `lk-jwt-service` POST treats the value as an opaque URL so a bad entry
 * surfaces only as a confusing fetch error.
 */
function parseFociFromWellKnown(
	wellKnown: unknown,
	roomId: string,
): LivekitTransport[] {
	if (typeof wellKnown !== "object" || wellKnown === null) return [];
	const raw = (wellKnown as Record<string, unknown>)[
		"org.matrix.msc4143.rtc_foci"
	];
	if (!Array.isArray(raw)) return [];
	const out: LivekitTransport[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as Record<string, unknown>;
		if (e.type !== "livekit") continue;
		const serviceUrl = e.livekit_service_url;
		if (typeof serviceUrl !== "string") continue;
		const trimmed = serviceUrl.trim();
		if (trimmed.length === 0) continue;
		// External data: validate that the URL is absolute and uses an
		// http(s) scheme before propagating to fetchLivekitToken — a
		// malformed or hostile well-known could otherwise direct the
		// OpenID token POST at the app origin (relative URL) or a
		// non-http scheme (javascript:, file:, etc.). Skip invalid
		// entries so discovery can fall through to other valid foci or
		// the EC fallback.
		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			continue;
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			continue;
		}
		// MatrixRTC membership events carry one transport per focus; the
		// `livekit_alias` is the per-call room handle the SFU keys on.
		out.push({
			type: "livekit",
			livekit_service_url: trimmed,
			livekit_alias: roomId,
		});
	}
	return out;
}

/**
 * Resolve the preferred LiveKit foci list for a MatrixRTC join.
 *
 * Order of precedence:
 *  1. `org.matrix.msc4143.rtc_foci` already cached on the MatrixClient
 *     (populated by the SDK when `clientWellKnownPollPeriod` is enabled).
 *  2. Live `GET https://${client.getDomain()}/.well-known/matrix/client`
 *     fetch — the SDK does not poll by default, so a cold start needs to
 *     read it on demand. Matches the pattern used by
 *     `src/features/auth/discovery.ts`.
 *  3. `buildFallbackLivekitFoci(elementCallUrl, roomId)` — EC-bundled
 *     fallback when the homeserver does not advertise any foci.
 *
 * Network failures, malformed responses, and missing client methods all
 * silently fall through to the next step so a missing `.well-known`
 * document does not block the call entirely. The function never throws.
 *
 * `fetchImpl` is injectable for tests.
 *
 * The well-known fetch is bounded by a 5-second timeout via AbortController
 * so a hung server (TCP connection accepted but no response) cannot
 * permanently block the call — the abort surfaces as a rejection and the
 * EC-bundled fallback runs.
 */
export async function discoverLivekitFoci(
	client: MatrixClient,
	elementCallUrl: string,
	roomId: string,
	options?: {
		fetchImpl?: typeof fetch;
		timeoutMs?: number;
		signal?: AbortSignal;
	},
): Promise<LivekitTransport[]> {
	// 1. Cached well-known on the client (set by the SDK's poller, if
	//    enabled, or by an earlier discovery in this session).
	try {
		const cached = client.getClientWellKnown?.();
		const fromCache = parseFociFromWellKnown(cached, roomId);
		if (fromCache.length > 0) return fromCache;
	} catch {
		// getClientWellKnown is not present on every client shape (tests
		// stub it out); ignore and continue to live fetch.
	}

	// 2. Live fetch of .well-known/matrix/client. The SDK does not poll
	//    by default so this is the path that runs in production today.
	const domain = client.getDomain?.();
	if (typeof domain === "string" && domain.length > 0) {
		const fetchImpl =
			options?.fetchImpl ??
			(typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
		if (fetchImpl) {
			const timeoutMs = options?.timeoutMs ?? 5_000;
			const controller =
				typeof AbortController === "function"
					? new AbortController()
					: undefined;
			const timer = controller
				? setTimeout(() => controller.abort(), timeoutMs)
				: undefined;
			// Mirror the caller-supplied signal (e.g. onCleanup) into
			// our local controller so an external cancel aborts the
			// fetch immediately instead of waiting out the timeout.
			const onExternalAbort = () => controller?.abort();
			if (options?.signal && controller) {
				if (options.signal.aborted) {
					controller.abort();
				} else {
					options.signal.addEventListener("abort", onExternalAbort);
				}
			}
			try {
				const res = await fetchImpl(
					`https://${domain}/.well-known/matrix/client`,
					controller ? { signal: controller.signal } : undefined,
				);
				if (res.ok) {
					const body = await res.json();
					const fromFetch = parseFociFromWellKnown(body, roomId);
					if (fromFetch.length > 0) return fromFetch;
				}
			} catch {
				// Network error / abort / malformed JSON / non-2xx — fall
				// through to the EC-bundled fallback.
			} finally {
				if (timer !== undefined) clearTimeout(timer);
				options?.signal?.removeEventListener("abort", onExternalAbort);
			}
		}
	}

	// 3. EC-bundled fallback derived from the operator-configured EC URL.
	return buildFallbackLivekitFoci(elementCallUrl, roomId);
}
