import { ClientPrefix, type MatrixClient, Method } from "matrix-js-sdk";
import type { LivekitTransport } from "matrix-js-sdk/lib/matrixrtc";
import { meansEndpointUnsupported } from "../../../../lib/endpointUnsupported";

/**
 * Builds the EC-bundled fallback LiveKit foci list. Derives the
 * `livekit_service_url` from the operator-configured Element Call URL,
 * following EC's bundled-nginx convention of `${url}/livekit/sfu/get`
 * for the `lk-jwt-service` sidecar endpoint. Used when neither the MSC4519
 * transports endpoint nor `.well-known` yields a LiveKit focus, and when the
 * endpoint answers that this user has none.
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
 * Extract LiveKit foci from a parsed `.well-known/matrix/client` document:
 * the `org.matrix.msc4143.rtc_foci` list, validated by
 * {@link parseLivekitTransports}.
 */
function parseFociFromWellKnown(
	wellKnown: unknown,
	roomId: string,
): LivekitTransport[] {
	if (typeof wellKnown !== "object" || wellKnown === null) return [];
	return parseLivekitTransports(
		(wellKnown as Record<string, unknown>)["org.matrix.msc4143.rtc_foci"],
		roomId,
	);
}

/**
 * Validate a server-supplied transport list (the MSC4519 `rtc_transports`
 * array or the `.well-known` `rtc_foci` one - same entry shape) down to the
 * LiveKit entries this client can use. One validator for both sources: the
 * `lk-jwt-service` POST treats the URL as opaque, so a bad entry from either
 * would surface only as a confusing fetch error.
 */
function parseLivekitTransports(
	raw: unknown,
	roomId: string,
): LivekitTransport[] {
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
 * Clients whose homeserver has said it does not serve the MSC4519 transports
 * endpoint. The MSC defines no `unstable_features` flag to check first (the
 * endpoint lives under MSC4143's namespace and, as the SDK notes, can only be
 * probed by asking), so the gate the AGENTS.md server-quirks rule asks for is
 * attempt-once-and-remember: a server that answers `M_UNRECOGNIZED` /
 * `M_NOT_FOUND` (`meansEndpointUnsupported`, the same rule `/search` uses) is
 * not asked again for the life of the client. Only that errcode is
 * remembered; a bare 404 from a proxy, a timeout, a network error or a 5xx is
 * the server being fronted badly, slow or down, and the next join asks again.
 *
 * Keyed weakly by client so an account switch (a new client) starts fresh;
 * tests build a fresh client per case for the same reason.
 */
const transportsUnsupported = new WeakSet<MatrixClient>();

/**
 * Resolve the preferred LiveKit foci list for a MatrixRTC join.
 *
 * Order of precedence:
 *  0. MSC4519 `GET /_matrix/client/unstable/org.matrix.msc4143/rtc/transports`
 *     (through `client.http.authedRequest`, see the step), which is what
 *     Element Call has preferred since v0.24 and what homeserver admins are being told
 *     they may replace `.well-known` with. Authenticated and per-user, so a
 *     server can hand different users different SFUs - which is why an
 *     answer, even an empty one, is final: a server that hands this user no
 *     transport is not overridden by the unauthenticated, global
 *     `.well-known` list, only by the operator's own EC-bundled derivation
 *     (step 3). Skipped for a client whose server has already said it does
 *     not serve it (see {@link transportsUnsupported}).
 *  1. `org.matrix.msc4143.rtc_foci` already cached on the MatrixClient
 *     (populated by the SDK when `clientWellKnownPollPeriod` is enabled).
 *  2. Live `GET https://${client.getDomain()}/.well-known/matrix/client`
 *     fetch - the SDK does not poll by default, so a cold start needs to
 *     read it on demand. Matches the pattern used by
 *     `src/features/auth/discovery.ts`. The step that runs against a
 *     homeserver without MSC4519; Continuwuity serves the endpoint as of
 *     v26.8, so on strange.pizza step 0 answers and this never runs.
 *  3. `buildFallbackLivekitFoci(elementCallUrl, roomId)` - EC-bundled
 *     fallback when the homeserver does not advertise any foci.
 *
 * Network failures, malformed responses, and missing client methods all
 * silently fall through to the next step so a missing `.well-known`
 * document does not block the call entirely. The function never throws.
 *
 * `fetchImpl` is injectable for tests.
 *
 * The two network steps share ONE deadline (5 s by default, `timeoutMs`):
 * whatever the transports request leaves of it is what the `.well-known`
 * fetch gets, so a hung server (TCP connection accepted but no response)
 * delays the join by at most that budget, not twice it. Each request runs
 * under a signal (`boundedSignal`) that fires when its share expires or the
 * caller's `signal` does, so it is cancelled for real and nothing is left
 * dangling on the homeserver origin that `/sync` shares.
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
	const timeoutMs = options?.timeoutMs ?? 5_000;
	const deadline = Date.now() + timeoutMs;
	const remainingMs = (): number => Math.max(0, deadline - Date.now());

	// 0. MSC4519 transports endpoint, through the HTTP layer rather than the
	//    SDK's `_unstable_getRTCTransports` convenience, because only the
	//    layer takes an `abortSignal`. The deadline is enforced here rather
	//    than through the SDK's `localTimeoutMs`: that timer starts only once
	//    the SDK has finished any OAuth token refresh it awaits first, and a
	//    retry after `M_UNKNOWN_TOKEN` restarts it, so it does not bound the
	//    wait.
	const http = client.http;
	if (
		typeof http?.authedRequest === "function" &&
		!transportsUnsupported.has(client) &&
		remainingMs() > 0 &&
		!options?.signal?.aborted
	) {
		const bound = boundedSignal(remainingMs(), options?.signal);
		try {
			const res = await http.authedRequest<{ rtc_transports?: unknown }>(
				Method.Get,
				"/rtc/transports",
				undefined,
				undefined,
				{
					prefix: `${ClientPrefix.Unstable}/org.matrix.msc4143`,
					abortSignal: bound.signal,
				},
			);
			// A 2xx without the array is a shapeless answer (a proxy's `{}`),
			// not an empty one: it falls through like any malformed response.
			// The array, even empty, is the server's answer for this user.
			if (Array.isArray(res?.rtc_transports)) {
				const fromEndpoint = parseLivekitTransports(res.rtc_transports, roomId);
				return fromEndpoint.length > 0
					? fromEndpoint
					: buildFallbackLivekitFoci(elementCallUrl, roomId);
			}
		} catch (err) {
			if (meansEndpointUnsupported(err)) transportsUnsupported.add(client);
			// Anything else (timeout, abort, network, 5xx, bare 404, malformed)
			// falls through to `.well-known` for this join and asks again on
			// the next.
		} finally {
			bound.release();
		}
	}

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
	if (
		typeof domain === "string" &&
		domain.length > 0 &&
		remainingMs() > 0 &&
		!options?.signal?.aborted
	) {
		const fetchImpl =
			options?.fetchImpl ??
			(typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
		if (fetchImpl) {
			const bound = boundedSignal(remainingMs(), options?.signal);
			try {
				const res = await fetchImpl(
					`https://${domain}/.well-known/matrix/client`,
					{ signal: bound.signal },
				);
				if (res.ok) {
					const body = await res.json();
					const fromFetch = parseFociFromWellKnown(body, roomId);
					if (fromFetch.length > 0) return fromFetch;
				}
			} catch {
				// Network error / abort / malformed JSON / non-2xx - fall
				// through to the EC-bundled fallback.
			} finally {
				bound.release();
			}
		}
	}

	// 3. EC-bundled fallback derived from the operator-configured EC URL.
	return buildFallbackLivekitFoci(elementCallUrl, roomId);
}

/**
 * A signal that fires after `timeoutMs` or when `external` (the caller's
 * abort, e.g. the overlay closing) fires, whichever is first. One mechanism
 * for both discovery requests; `release` disarms it once the request has
 * settled so a timer never outlives the step it bounded.
 */
function boundedSignal(
	timeoutMs: number,
	external?: AbortSignal,
): { signal: AbortSignal; release: () => void } {
	const controller = new AbortController();
	const onExternalAbort = () => controller.abort();
	if (external?.aborted) controller.abort();
	else external?.addEventListener("abort", onExternalAbort);
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	return {
		signal: controller.signal,
		release: () => {
			clearTimeout(timer);
			external?.removeEventListener("abort", onExternalAbort);
		},
	};
}
