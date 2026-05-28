import type { IOpenIDToken } from "matrix-js-sdk";
import type { LivekitTransport } from "matrix-js-sdk/lib/matrixrtc";

export interface LivekitJwtResponse {
	/** wss:// URL of the LiveKit SFU. */
	url: string;
	/** Signed access token to pass to `Room.connect`. */
	jwt: string;
}

/**
 * Normalises an `lk-jwt-service` endpoint. Element Call's deployment
 * convention (matching `discoverFoci.ts`) exposes the JWT issuer at
 * `${base}/livekit/sfu/get`. Some operator configs store the path
 * partially or just the bare base. We accept three shapes so
 * `.well-known`-sourced foci (Phase 3+) keep working:
 *   - `${base}/livekit/sfu/get` → use as-is
 *   - `${base}/livekit`         → append `/sfu/get`
 *   - `${base}`                 → append `/livekit/sfu/get`
 *
 * Parses with the URL API so any `?query`/`#fragment` is preserved
 * verbatim and we don't accidentally splice path segments after it.
 */
function normaliseJwtServiceUrl(input: string): string {
	const trimmed = input.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		// Fall back to string handling for genuinely opaque inputs; the
		// downstream fetch will surface a clearer error if it's invalid.
		const stripped = trimmed.replace(/\/+$/, "");
		if (stripped.endsWith("/sfu/get")) return stripped;
		if (stripped.endsWith("/livekit")) return `${stripped}/sfu/get`;
		return `${stripped}/livekit/sfu/get`;
	}
	const path = parsed.pathname.replace(/\/+$/, "");
	if (path.endsWith("/sfu/get")) {
		parsed.pathname = path;
	} else if (path.endsWith("/livekit")) {
		parsed.pathname = `${path}/sfu/get`;
	} else {
		parsed.pathname = `${path}/livekit/sfu/get`;
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
