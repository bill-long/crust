import {
	ClientPrefix,
	type IOpenIDToken,
	type MatrixClient,
	Method,
} from "matrix-js-sdk";
import type { LivekitTransport } from "matrix-js-sdk/lib/matrixrtc";
import { meansEndpointUnsupported } from "../../../../lib/endpointUnsupported";
import { type LocalRtcMembership, RTC_SLOT } from "./rtcProtocol";

export interface LivekitJwtResponse {
	localIdentity?: string;
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
 * absolute `http:` / `https:` URL. `parseLivekitTransports` (both the
 * transports endpoint and `.well-known`) already filters these out at
 * ingestion, but a relative / non-http(s) value
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
 * `deviceId` MUST be the same value matrix-js-sdk's `MatrixRTCSession`
 * uses for the local participant (i.e. `client.getDeviceId()`).
 * lk-jwt-service derives the LiveKit participant identity as
 * `<matrixUserId>:<deviceId>` (see element-hq/lk-jwt-service main.go,
 * field `device_id`), and that string must match the bridge's keyProvider
 * entries (built from matrix-js-sdk's `rtcBackendIdentity =
 * `${userId}:${deviceId}``). Sending an empty/missing `device_id` produces
 * an identity like `@user:server:` that does not match what the bridge
 * stores keys under, breaking E2EE for other participants.
 *
 * @throws {LivekitJwtError} On non-2xx, malformed response, network error,
 *   or when `deviceId` is empty.
 */
async function fetchLegacyToken(
	focus: LivekitTransport,
	openIdToken: IOpenIDToken,
	deviceId: string,
	options?: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<LivekitJwtResponse> {
	const fetchImpl =
		options?.fetchImpl ??
		(typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
	if (!fetchImpl) {
		throw new LivekitJwtError("fetch is not available in this environment");
	}
	// Defence in depth: callers already validate, but an empty device_id
	// silently produces a mismatched LiveKit participant identity (see
	// jsdoc above), so refuse it at the fetch boundary too.
	if (!deviceId) {
		throw new LivekitJwtError(
			"Cannot request LiveKit JWT without a Matrix device ID",
		);
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
				device_id: deviceId,
			}),
			...(options?.signal !== undefined ? { signal: options.signal } : {}),
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

interface TokenOptions {
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	client?: Pick<MatrixClient, "http">;
	membership?: LocalRtcMembership | null | undefined;
	subscriber?: boolean;
}

/** Select authentication to match the identities advertised by the publishing membership.
 * Current C-S uses member_id; the deprecated standalone route still uses member.
 * A publisher never uses the old three-component hash returned by /get_token.
 */
export async function fetchLivekitToken(
	focus: LivekitTransport,
	openIdToken: IOpenIDToken | (() => Promise<IOpenIDToken>),
	deviceId: string,
	options?: TokenOptions,
): Promise<LivekitJwtResponse> {
	const own = options?.membership;
	let tokenPromise: Promise<IOpenIDToken> | undefined;
	const getOpenId = () =>
		(tokenPromise ??=
			typeof openIdToken === "function"
				? openIdToken()
				: Promise.resolve(openIdToken));
	if (!deviceId || (own && own.deviceId !== deviceId))
		throw new LivekitJwtError(
			"Cannot request LiveKit JWT without a matching Matrix device ID",
		);
	if (
		own &&
		typeof focus.url === "string" &&
		(own.modern || options?.subscriber)
	) {
		if (!options?.client)
			throw new LivekitJwtError("Matrix client required for RTC token request");
		const parsed = new URL(focus.url);
		if (!["wss:", "ws:"].includes(parsed.protocol))
			throw new LivekitJwtError("Invalid LiveKit WebSocket URL");
		try {
			// SDK 44's convenience method still types the pre-v0.8 request body.
			// Keep this wire adaptation here until the SDK accepts flat member_id.
			const response = await options.client.http.authedRequest<{ jwt: string }>(
				Method.Post,
				"/rtc/livekit/get_token",
				undefined,
				{
					url: focus.url,
					room_id: own.roomId,
					slot_id: RTC_SLOT,
					member_id: own.memberId,
					...(focus.server_name ? { server_name: focus.server_name } : {}),
				},
				{
					prefix: `${ClientPrefix.Unstable}/io.element.msc4195`,
					...(options.signal ? { abortSignal: options.signal } : {}),
				},
			);
			if (typeof response.jwt !== "string" || !response.jwt)
				throw new LivekitJwtError("RTC token response missing jwt");
			return {
				url: focus.url,
				jwt: response.jwt,
				localIdentity: own.backendIdentity,
			};
		} catch (e) {
			if (!meansEndpointUnsupported(e) || !focus.livekit_service_url) throw e;
		}
	}
	if (own && options?.subscriber && focus.livekit_service_url) {
		const url = new URL(normaliseJwtServiceUrl(focus.livekit_service_url));
		url.pathname = url.pathname.replace(/\/sfu\/get$/, "/get_token");
		const response = await (options.fetchImpl ?? fetch)(url.toString(), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			...(options.signal ? { signal: options.signal } : {}),
			body: JSON.stringify({
				room_id: own.roomId,
				slot_id: RTC_SLOT,
				openid_token: await getOpenId(),
				member: {
					id: own.memberId,
					claimed_user_id: own.userId,
					claimed_device_id: deviceId,
				},
			}),
		});
		if (response.ok) {
			const body = await response.json();
			if (typeof body?.url !== "string" || typeof body?.jwt !== "string")
				throw new LivekitJwtError(
					"lk-jwt-service response missing url/jwt fields",
				);
			// Subscriber connections never publish, so their own identity does not
			// participate in remote decryption. Only received peers need key bindings.
			return { url: body.url, jwt: body.jwt };
		}
		if (![404, 405].includes(response.status))
			throw new LivekitJwtError(
				`lk-jwt-service returned ${response.status}`,
				response.status,
			);
	}
	if (!focus.livekit_service_url)
		throw new LivekitJwtError("No compatible LiveKit token endpoint");
	const response = await fetchLegacyToken(
		{ ...focus, livekit_alias: focus.livekit_alias || own?.roomId },
		await getOpenId(),
		deviceId,
		options,
	);
	return own
		? { ...response, localIdentity: `${own.userId}:${deviceId}` }
		: response;
}
