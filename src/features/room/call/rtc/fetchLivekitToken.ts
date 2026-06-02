import type { IOpenIDToken } from "matrix-js-sdk";
import type { LivekitTransport } from "matrix-js-sdk/lib/matrixrtc";

export interface LivekitJwtResponse {
	/** wss:// URL of the LiveKit SFU. */
	url: string;
	/** Signed access token to pass to `Room.connect`. */
	jwt: string;
}

/**
 * Normalises an `lk-jwt-service` endpoint.
 *
 * `lk-jwt-service`'s route is `/sfu/get`. Deployments differ on what they
 * publish in `org.matrix.msc4143.rtc_foci`'s `livekit_service_url` (or in
 * `config.elementCall.url` for the EC-bundled fallback):
 *
 *   - bare host (`https://livekit.example.com`) — MSC4143 standard, also
 *     Element's reference deployment when lk-jwt-service runs on its own
 *     subdomain. JWT endpoint: `${base}/sfu/get`.
 *   - prefixed path (`https://example.com/livekit` or `.../livekit/jwt`) —
 *     EC-bundled nginx where everything sits behind one origin and the
 *     reverse proxy strips the prefix. JWT endpoint: `${base}/sfu/get`.
 *   - fully-qualified (`${base}/sfu/get`) — some operators store the
 *     terminal endpoint directly. Pass through unchanged.
 *
 * Parses with the URL API so any `?query`/`#fragment` is preserved
 * verbatim and we don't accidentally splice path segments after it.
 *
 * Defence-in-depth scheme validation: rejects any input that isn't an
 * absolute `http:` / `https:` URL. `parseFociFromWellKnown` already
 * filters these out at ingestion, but a relative / non-http(s) value
 * arriving here (e.g. via a custom `discoverFoci` override or a
 * misconfigured `elementCall.url`) would otherwise cause `fetch` to
 * POST the OpenID token to the app origin or a non-http(s) handler.
 *
 * @throws {LivekitJwtError} If the input isn't a valid absolute http(s) URL.
 */
function normaliseJwtServiceUrl(input: string): string {
	const trimmed = input.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new LivekitJwtError(
			`Invalid LiveKit service URL (not an absolute URL): ${input}`,
		);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new LivekitJwtError(
			`Invalid LiveKit service URL (must be http(s)): ${input}`,
		);
	}
	const path = parsed.pathname.replace(/\/+$/, "");
	if (path.endsWith("/sfu/get")) {
		parsed.pathname = path;
	} else {
		parsed.pathname = `${path}/sfu/get`;
	}
	return parsed.toString();
}

export class LivekitJwtError extends Error {
	readonly status: number | null;
	constructor(message: string, status: number | null = null) {
		super(message);
		this.name = "LivekitJwtError";
		this.status = status;
	}
}

/**
 * Exchanges an OpenID token for a LiveKit SFU URL + JWT via `lk-jwt-service`.
 *
 * Always pair this with a freshly fetched `client.getOpenIdToken()` — tokens
 * are short-lived and shouldn't be cached across reconnects (per the SDK
 * note, they're scoped to a single backend call).
 *
 * @throws {LivekitJwtError} On non-2xx, malformed response, or network error.
 */
export async function fetchLivekitToken(
	focus: LivekitTransport,
	openIdToken: IOpenIDToken,
	options?: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<LivekitJwtResponse> {
	const fetchImpl =
		options?.fetchImpl ??
		(typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
	if (!fetchImpl) {
		throw new LivekitJwtError("fetch is not available in this environment");
	}
	const url = normaliseJwtServiceUrl(focus.livekit_service_url);

	let res: Response;
	try {
		res = await fetchImpl(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				room: focus.livekit_alias,
				openid_token: openIdToken,
			}),
			signal: options?.signal,
		});
	} catch (e) {
		if (e instanceof DOMException && e.name === "AbortError") throw e;
		throw new LivekitJwtError(
			`Network error contacting lk-jwt-service: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}

	if (!res.ok) {
		throw new LivekitJwtError(
			`lk-jwt-service returned ${res.status} ${res.statusText}`,
			res.status,
		);
	}

	let body: unknown;
	try {
		body = await res.json();
	} catch (e) {
		throw new LivekitJwtError(
			`Malformed JSON from lk-jwt-service: ${
				e instanceof Error ? e.message : String(e)
			}`,
			res.status,
		);
	}

	if (
		typeof body !== "object" ||
		body === null ||
		typeof (body as { url?: unknown }).url !== "string" ||
		typeof (body as { jwt?: unknown }).jwt !== "string"
	) {
		throw new LivekitJwtError(
			"lk-jwt-service response missing url/jwt fields",
			res.status,
		);
	}

	return {
		url: (body as { url: string }).url,
		jwt: (body as { jwt: string }).jwt,
	};
}
