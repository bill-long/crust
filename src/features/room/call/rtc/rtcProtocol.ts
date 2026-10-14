import type { MatrixClient } from "matrix-js-sdk";
import type {
	CallMembership,
	LivekitTransport,
	Transport,
} from "matrix-js-sdk/lib/matrixrtc";
import { readMyMembership } from "../../../../client/stateEventPermission";
import type { SummariesStore } from "../../../../client/summaries";
import { reportError } from "../../../../lib/reportError";

export interface LocalRtcMembership {
	roomId: string;
	userId: string;
	deviceId: string;
	memberId: string;
	backendIdentity: string;
	modern: boolean;
}

export const RTC_SLOT = "m.call#ROOM";
export const RTC_MEMBER_EVENT = "org.matrix.msc4143.rtc.member";
export const LEGACY_MEMBER_EVENT = "org.matrix.msc3401.call.member";

export async function supportsRtcMembership(
	client: MatrixClient,
): Promise<boolean | null> {
	try {
		return await client.doesServerSupportUnstableFeature("org.matrix.msc4354");
	} catch {
		// Unknown is retryable; it must not become a cached unsupported result.
		return null;
	}
}

/** Internal normalization keeps legacy callers usable with alias-less and URL-only transports. */
export function livekitTransport(
	value: unknown,
	roomId: string,
): LivekitTransport | null {
	if (!value || typeof value !== "object") return null;
	const t = value as Record<string, unknown>;
	if (t.type !== "livekit") return null;
	let service =
		typeof t.livekit_service_url === "string"
			? t.livekit_service_url.trim()
			: "";
	let url = typeof t.url === "string" ? t.url.trim() : "";
	const valid = (s: string, protocols: string[]) => {
		try {
			return protocols.includes(new URL(s).protocol);
		} catch {
			return false;
		}
	};
	if (service && !valid(service, ["https:", "http:"])) service = "";
	if (url && !valid(url, ["wss:", "ws:"])) url = "";
	if (!service && !url) return null;
	return {
		type: "livekit",
		livekit_service_url: service,
		livekit_alias:
			typeof t.livekit_alias === "string" && t.livekit_alias
				? t.livekit_alias
				: roomId,
		...(url ? { url } : {}),
		...(typeof t.server_name === "string"
			? { server_name: t.server_name }
			: {}),
	};
}

/** Empty compatibility fields must never become advertised wire capabilities. */
export function publishedTransport(t: LivekitTransport): Transport {
	return {
		type: "livekit",
		...(t.livekit_service_url
			? {
					livekit_service_url: t.livekit_service_url,
					livekit_alias: t.livekit_alias,
				}
			: {}),
		...(t.url ? { url: t.url } : {}),
	};
}

export function transportAddress(
	t: LivekitTransport | null | undefined,
): string | undefined {
	return (
		(typeof t?.url === "string" ? t.url : t?.livekit_service_url) || undefined
	);
}

/** SDK 44 no longer elects an SFU for pre-multi-SFU peers. Preserve their wire meaning. */
export function membershipTransport(
	client: MatrixClient,
	roomId: string,
	membership: CallMembership,
	memberships: readonly CallMembership[],
): LivekitTransport | null {
	const state = client.getRoom(roomId)?.currentState;
	const event = state
		?.getStateEvents(LEGACY_MEMBER_EVENT)
		.find((e) => e.getId() === membership.eventId);
	const elected =
		event?.getContent().focus_active?.focus_selection === "oldest_membership"
			? (oldestLegacyMembership(client, roomId, memberships) ?? membership)
			: membership;
	let transport: LivekitTransport | null;
	try {
		transport = livekitTransport(elected.getTransport(elected), roomId);
	} catch (error) {
		// Some legacy events omit foci_preferred, which the SDK getter dereferences.
		reportError(error, { logLabel: "rtc: cannot resolve published transport" });
		return null;
	}
	if (transport?.url)
		transport.server_name = elected.userId.slice(
			elected.userId.indexOf(":") + 1,
		);
	return transport;
}

export function canPublishMembership(
	client: Pick<MatrixClient, "getRoom" | "getUserId">,
	roomId: string,
	modern: boolean,
	summaries?: SummariesStore,
): boolean {
	if (readMyMembership(client, roomId, summaries) !== "join") return false;
	const state = client.getRoom(roomId)?.currentState;
	const userId = client.getUserId();
	if (!state || !userId) return false;
	return modern
		? state.maySendEvent(RTC_MEMBER_EVENT, userId)
		: state.maySendStateEvent(LEGACY_MEMBER_EVENT, userId);
}

/** Deprecated standalone subscriber alias, for roster resolution only, never key binding. */
export async function standaloneSubscriberIdentity(
	userId: string,
	deviceId: string,
	memberId: string,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify([userId, deviceId, memberId])),
	);
	return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(
		/=+$/,
		"",
	);
}

/** Legacy clients only elect members carried in room state, never sticky RTC events. */
export function oldestLegacyMembership(
	client: MatrixClient,
	roomId: string,
	members: readonly CallMembership[],
): CallMembership | undefined {
	const ids = new Set(
		client
			.getRoom(roomId)
			?.currentState.getStateEvents(LEGACY_MEMBER_EVENT)
			.map((e) => e.getId()) ?? [],
	);
	return members
		.filter((m) => ids.has(m.eventId))
		.reduce<CallMembership | undefined>(
			(oldest, m) =>
				!oldest || m.createdTs() < oldest.createdTs() ? m : oldest,
			undefined,
		);
}

/** One eligibility and format decision shared by the entry button and join operation. */
export function selectRtcTransport(
	client: MatrixClient,
	roomId: string,
	foci: readonly LivekitTransport[],
	sticky: boolean | null,
	members: readonly CallMembership[],
	summaries?: SummariesStore,
): { focus: LivekitTransport; modern: boolean } | null {
	if (sticky && canPublishMembership(client, roomId, true, summaries)) {
		const focus = foci.find((f) => typeof f.url === "string");
		if (focus) return { focus, modern: true };
	}
	if (!canPublishMembership(client, roomId, false, summaries)) return null;
	const oldest = oldestLegacyMembership(client, roomId, members);
	const elected = oldest
		? membershipTransport(client, roomId, oldest, members)
		: null;
	const focus = elected?.livekit_service_url
		? elected
		: foci.find((f) => f.livekit_service_url);
	return focus ? { focus: { ...focus, url: undefined }, modern: false } : null;
}
