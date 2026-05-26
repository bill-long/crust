import type { LivekitTransport } from "matrix-js-sdk/lib/matrixrtc";

/**
 * Builds the preferred LiveKit foci list for a MatrixRTC join.
 *
 * Phase 1 (#122) — synchronous fallback only: derives the
 * `livekit_service_url` from the operator-configured Element Call URL,
 * following EC's deployment convention of `${url}/livekit/sfu/get` for the
 * `lk-jwt-service` sidecar endpoint. Phase 2 will replace this with
 * `.well-known/matrix/client` discovery of `org.matrix.msc4143.rtc_foci`,
 * with this function as the last-resort fallback.
 *
 * Membership-only joins (Phase 1) publish this transport in the call-member
 * state event but do not actually connect to it — media comes in Phase 2.
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
