import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import {
	CALL_MEMBER_EVENT_TYPE,
	callMembershipExpiresAt,
} from "../../../client/summaries";

/**
 * Derived text for a non-message state event (m.room.member, m.room.name,
 * etc.), rendered as a compact one-line notice in the timeline. Mirrors
 * what Element / Cinny / Discord show for the same events. Returns null
 * when the event carries no user-visible change (e.g. join->join with
 * identical profile, no-op topic write).
 */
/**
 * Leading-glyph category for a state notice, mirroring how Element / Cinny
 * differentiate membership transitions in the timeline gutter: an arrow-in
 * for arrivals, an arrow-out for departures, and a neutral info glyph for
 * everything else (profile, room name/topic/avatar, encryption, etc.).
 */
export type StateNoticeIcon = "join" | "leave" | "info";

export interface StateNotice {
	text: string;
	icon: StateNoticeIcon;
}

/** Leading glyph for a grouped membership run, keyed by its transition kind. */
export function iconForTransitionKind(
	kind: MembershipTransitionKind,
): StateNoticeIcon {
	switch (kind) {
		case "join":
		case "invite":
		case "call_join":
			return "join";
		case "leave":
		case "kick":
		case "ban":
		case "call_leave":
			return "leave";
	}
}

/**
 * Membership transitions that the timeline groups into a single collapsed
 * notice ("Alice, Bob and 3 others joined"). Profile-only member changes
 * (display name / avatar while joined), invite withdrawals/rejections, and
 * unbans are intentionally NOT grouping transitions — they stay individual.
 */
export type MembershipTransitionKind =
	| "join"
	| "leave"
	| "invite"
	| "kick"
	| "ban"
	| "call_join"
	| "call_leave";

export interface MembershipTransition {
	kind: MembershipTransitionKind;
	/** Matrix user ID of the affected member (the event's state_key). */
	userId: string;
	/** Display name of the affected user (resolved from the event/state). */
	subject: string;
	/** http avatar URL of the affected user, or null when none is known. */
	avatarUrl: string | null;
}

/** State event types that the timeline renders as a notice. */
export const STATE_NOTICE_TYPES: ReadonlySet<string> = new Set([
	"m.room.member",
	"m.room.name",
	"m.room.topic",
	"m.room.avatar",
	"m.room.encryption",
	"m.room.canonical_alias",
	"m.room.tombstone",
	CALL_MEMBER_EVENT_TYPE,
]);

export function isStateNoticeType(type: string): boolean {
	return STATE_NOTICE_TYPES.has(type);
}

function actorName(event: MatrixEvent, room: Room): string {
	const sender = event.getSender() ?? "";
	const name = room.getMember(sender)?.name?.trim();
	return name && name.length > 0 ? name : sender;
}

/**
 * Subject of an `m.room.member` event — the user the state refers to
 * (the `state_key`). Prefers the historical display name from the
 * event itself (content / prev_content), falling back to the current
 * room member name, then the bare matrix ID. The historical name
 * matters because the affected user may have left and `room.getMember`
 * will return null.
 */
function memberSubjectName(
	room: Room,
	stateKey: string,
	content: Record<string, unknown>,
	prevContent: Record<string, unknown>,
): string {
	const fromContent =
		typeof content.displayname === "string" && content.displayname.trim();
	if (fromContent) return fromContent;
	const fromPrev =
		typeof prevContent.displayname === "string" &&
		prevContent.displayname.trim();
	if (fromPrev) return fromPrev;
	const member = room.getMember(stateKey)?.name?.trim();
	if (member && member.length > 0) return member;
	return stateKey;
}

function getPrevContent(event: MatrixEvent): Record<string, unknown> {
	if (typeof event.getPrevContent === "function") {
		const prev = event.getPrevContent();
		if (prev && typeof prev === "object") {
			return prev as Record<string, unknown>;
		}
	}
	return {};
}

function quoted(s: string): string {
	const trimmed = s.trim();
	return trimmed.length > 0 ? `"${trimmed}"` : "";
}

/**
 * Whether a MatrixRTC `org.matrix.msc3401.call.member` content blob
 * represents an active call membership. An empty blob (`{}`) is the
 * "left the call" tombstone. Both the modern MSC4143 flat per-device
 * shape and the legacy nested shapes (non-empty `m.calls` /
 * `memberships` arrays) count as present so the timeline can render
 * join/leave history regardless of the publishing client.
 *
 * For the modern flat shape this requires the SDK-mandatory identifying
 * fields (`application: "m.call"` plus string `call_id`, `device_id`,
 * and `focus_active.type`), mirroring `checkSessionsMembershipData` in
 * `summaries.ts` so a malformed payload (e.g. a bare
 * `{ application: "m.call" }`) is not mistaken for a real membership.
 * Unlike the live "active call" badge it intentionally does NOT apply
 * the badge's ROOM-slot `call_id` filter or `foci_preferred` validation:
 * historical notices cover any well-formed membership, including
 * non-primary call slots.
 */
function hasCallMembership(content: Record<string, unknown>): boolean {
	if (Object.keys(content).length === 0) return false;
	const focusActive = content.focus_active as { type?: unknown } | undefined;
	if (
		content.application === "m.call" &&
		typeof content.call_id === "string" &&
		typeof content.device_id === "string" &&
		typeof focusActive?.type === "string"
	) {
		return true;
	}
	const calls = content["m.calls"];
	if (Array.isArray(calls) && calls.length > 0) return true;
	const memberships = content.memberships;
	if (Array.isArray(memberships) && memberships.length > 0) return true;
	return false;
}

/**
 * Classify a call-member state event as an explicit join or leave by
 * diffing its content against its `prev_content`. A membership appearing
 * is a join; a membership being removed (content emptied) is a leave.
 * Returns null for non-transitions (membership refreshes that stay
 * present, or empty->empty no-ops).
 *
 * Scope/limitations (see issues #210, #215):
 *  - This is a single-event diff and is per-device: a user joining/leaving
 *    from two devices produces two transitions here. Per-device duplicates
 *    and premature leaves are reconciled into per-user liveness at the
 *    timeline layer by {@link computeCallTimelineNotices}, which hides the
 *    redundant notices.
 *  - Expiry-based leaves (a membership lapsing without a follow-up event)
 *    produce no event and therefore no notice. Only explicit transitions are
 *    covered; synthesizing expiry leaves is tracked separately.
 */
function classifyCallTransition(
	event: MatrixEvent,
): "call_join" | "call_leave" | null {
	const content = event.getContent() as Record<string, unknown>;
	const prev = getPrevContent(event);
	const currActive = hasCallMembership(content);
	const prevActive = hasCallMembership(prev);
	if (currActive && !prevActive) return "call_join";
	if (!currActive && prevActive) return "call_leave";
	return null;
}

/**
 * Device id a call-member transition refers to. A join carries it in the
 * current content; a leave empties the content, so the device id lives in
 * `prev_content`. Falls back to an empty-string sentinel for the legacy
 * nested shapes (`m.calls` / `memberships`) that don't expose a top-level
 * `device_id`, which collapses a user's device-less memberships into one
 * logical slot — best-effort, since per-device reconciliation targets the
 * modern MSC4143 flat shape.
 */
function callTransitionDeviceId(event: MatrixEvent): string {
	const content = event.getContent() as Record<string, unknown>;
	if (typeof content.device_id === "string") return content.device_id;
	const prev = getPrevContent(event);
	if (typeof prev.device_id === "string") return prev.device_id;
	return "";
}

/**
 * A "left the call" notice that has no backing `MatrixEvent` because the
 * membership lapsed by expiry (`created_ts + (expires ?? 4h)` passing) with no
 * follow-up state event. Anchored at `expiresAt` (server time, the same time
 * base as surrounding events' `getTs()`), keyed by the last device that lapsed.
 */
export interface SyntheticCallLeave {
	/** Matrix user ID whose last live membership lapsed. */
	userId: string;
	/** Device ID of that last-lapsing membership (for a stable synthetic key). */
	deviceId: string;
	/** Absolute server-time ms at which the user's last device expired. */
	expiresAt: number;
}

export interface CallTimelineNotices {
	/**
	 * Call-member event IDs whose notice must be hidden: a duplicate join
	 * while already present on another device, a premature leave while still
	 * present on another device, or a redundant explicit leave for a device
	 * that had already lapsed by expiry.
	 */
	suppressed: Set<string>;
	/**
	 * Synthetic "left the call" notices for memberships that lapsed by expiry
	 * (as of `now`) without a follow-up event — one per user, anchored at the
	 * moment their last live device expired.
	 */
	syntheticLeaves: SyntheticCallLeave[];
	/**
	 * Earliest future (`> now`) membership expiry among still-live devices, or
	 * `null` when none — used by the timeline to schedule a re-evaluation so a
	 * synthetic leave appears the instant the membership lapses.
	 */
	nextExpiry: number | null;
}

/**
 * Reconcile per-device MatrixRTC call memberships into per-user liveness,
 * expiry-aware, producing everything the timeline needs to render accurate
 * call join/leave notices:
 *
 *  - `suppressed`: redundant explicit notices to hide (duplicate join,
 *    premature leave, or a late explicit leave for an already-expired device).
 *  - `syntheticLeaves`: "left the call" notices to synthesize for memberships
 *    that lapsed by expiry with no follow-up event (issue #215 / #219).
 *  - `nextExpiry`: when to re-run this pass so a future expiry surfaces.
 *
 * `events` MUST be in timeline (chronological ascending) order. Liveness is
 * processed forward, expiring any device whose membership lapsed before each
 * subsequent event so a later explicit leave of a *different* device is judged
 * against the user's actually-live devices (not stale expired ones). A final
 * sweep up to `now` emits synthetic leaves for memberships that have since
 * lapsed.
 *
 * Expiry is only computed for the modern flat MSC4143 ROOM-slot shape (via
 * {@link callMembershipExpiresAt}); legacy/device-less or malformed
 * memberships are treated as never-expiring, so they only ever leave via an
 * explicit empty event (never a synthetic notice), matching `summaries.ts`.
 *
 * A periodic membership refresh (active->active, which carries a fresh
 * `expires`) updates the device's expiry in place, so a still-connected user
 * never gets a premature synthetic leave.
 */
export function computeCallTimelineNotices(
	events: readonly MatrixEvent[],
	now: number,
): CallTimelineNotices {
	const suppressed = new Set<string>();
	const syntheticLeaves: SyntheticCallLeave[] = [];
	// userId -> (deviceId -> absolute expiry ms; Infinity = never-expiring).
	const live = new Map<string, Map<string, number>>();
	// userId -> devices that had an active membership event somewhere in this
	// window. Lets an explicit leave for an already-ended device be recognized
	// as redundant, while a leave whose join is *before* the loaded window
	// (device never seen) still renders.
	const seen = new Map<string, Set<string>>();

	// Expire every live device whose expiry has passed `threshold`, in
	// ascending-expiry order, recording a synthetic leave each time a user's
	// last device lapses. `inclusive` selects `<= threshold` (the final sweep
	// at `now`) vs `< threshold` (between events, so a real event at exactly a
	// device's expiry — e.g. a refresh — wins the tie and keeps it alive).
	function sweepExpired(threshold: number, inclusive: boolean): void {
		const expired: { user: string; device: string; exp: number }[] = [];
		for (const [user, devices] of live) {
			for (const [device, exp] of devices) {
				if (inclusive ? exp <= threshold : exp < threshold) {
					expired.push({ user, device, exp });
				}
			}
		}
		if (expired.length === 0) return;
		// Ascending expiry so each user's last-removed (latest-expiring) device
		// is the one that empties it — the correct synthetic-leave anchor.
		expired.sort((a, b) => a.exp - b.exp);
		for (const { user, device, exp } of expired) {
			const devices = live.get(user);
			if (!devices?.has(device)) continue;
			devices.delete(device);
			if (devices.size === 0) {
				live.delete(user);
				syntheticLeaves.push({
					userId: user,
					deviceId: device,
					expiresAt: exp,
				});
			}
		}
	}

	for (const event of events) {
		if (event.getType() !== CALL_MEMBER_EVENT_TYPE) continue;
		// A redacted call-member event renders no notice (buildStateNotice
		// bails on redacted state events), so it must not affect liveness.
		if (typeof event.isRedacted === "function" && event.isRedacted()) {
			continue;
		}
		const sender = event.getSender();
		if (!sender) continue;
		const content = event.getContent() as Record<string, unknown>;
		const prev = getPrevContent(event);
		const active = hasCallMembership(content);
		const prevActive = hasCallMembership(prev);
		if (!active && !prevActive) continue;
		const eventId = event.getId();
		const device = callTransitionDeviceId(event);

		// Expire devices that lapsed strictly before this event so the
		// duplicate-join / premature-leave decisions below are expiry-aware.
		sweepExpired(event.getTs(), false);

		let devices = live.get(sender);
		if (active) {
			const wasPresent = devices !== undefined && devices.size > 0;
			if (!devices) {
				devices = new Map<string, number>();
				live.set(sender, devices);
			}
			let seenDevices = seen.get(sender);
			if (!seenDevices) {
				seenDevices = new Set<string>();
				seen.set(sender, seenDevices);
			}
			seenDevices.add(device);
			const expRaw = callMembershipExpiresAt(event);
			// Non-finite (null shape, or NaN from non-numeric `expires`) ->
			// never-expiring, so it only leaves via an explicit empty event.
			const exp =
				expRaw !== null && Number.isFinite(expRaw)
					? expRaw
					: Number.POSITIVE_INFINITY;
			// Latest membership wins: a refresh extends/updates the expiry.
			devices.set(device, exp);
			// A join transition (prev inactive) while the user already had a
			// live device is a per-device duplicate.
			if (!prevActive && wasPresent && eventId) suppressed.add(eventId);
		} else if (devices?.has(device)) {
			devices.delete(device);
			if (devices.size === 0) {
				// Last live device left explicitly — the notice renders.
				live.delete(sender);
			} else if (eventId) {
				// Another device is still live — premature.
				suppressed.add(eventId);
			}
		} else if (devices && devices.size > 0) {
			// This device already ended (lapsed by expiry, or left) but the user
			// is still live on another device — premature, suppress.
			if (eventId) suppressed.add(eventId);
		} else if (eventId && seen.get(sender)?.has(device)) {
			// The user is no longer live and this device was seen earlier in this
			// window — the leave is redundant (the device already lapsed by
			// expiry or left). A device whose join is *before* the loaded window
			// was never seen, so its leave falls through and renders.
			suppressed.add(eventId);
		}
	}

	// Emit synthetic leaves for memberships that have lapsed by expiry as of
	// `now` with no follow-up event.
	sweepExpired(now, true);

	let nextExpiry: number | null = null;
	for (const devices of live.values()) {
		for (const exp of devices.values()) {
			if (Number.isFinite(exp) && exp > now) {
				if (nextExpiry === null || exp < nextExpiry) nextExpiry = exp;
			}
		}
	}

	return { suppressed, syntheticLeaves, nextExpiry };
}

function callMemberNotice(event: MatrixEvent, room: Room): StateNotice | null {
	const transition = classifyCallTransition(event);
	if (!transition) return null;
	// Mirror summaries.ts: a call-member event with no sender has no
	// identifiable participant. Bail so we never render " joined the call"
	// or collide grouping dedupe on an empty userId.
	if (!event.getSender()) return null;
	const subject = actorName(event, room);
	return {
		text:
			transition === "call_join"
				? `${subject} joined the call`
				: `${subject} left the call`,
		icon: transition === "call_join" ? "join" : "leave",
	};
}

function memberNotice(event: MatrixEvent, room: Room): StateNotice | null {
	const stateKey =
		typeof event.getStateKey === "function" ? (event.getStateKey() ?? "") : "";
	if (!stateKey) return null;
	const content = event.getContent() as Record<string, unknown>;
	const prev = getPrevContent(event);
	const membership =
		typeof content.membership === "string" ? content.membership : "leave";
	const prevMembership =
		typeof prev.membership === "string" ? prev.membership : "leave";
	const sender = event.getSender() ?? "";
	const actor = actorName(event, room);
	const subject = memberSubjectName(room, stateKey, content, prev);

	// Profile-only update (display name or avatar change) while joined.
	if (membership === "join" && prevMembership === "join") {
		const oldName =
			typeof prev.displayname === "string" ? prev.displayname.trim() : "";
		const newName =
			typeof content.displayname === "string" ? content.displayname.trim() : "";
		if (oldName !== newName) {
			if (oldName && newName) {
				return {
					text: `${oldName} changed their name to ${newName}`,
					icon: "info",
				};
			}
			if (newName) {
				// Subject derives from content.displayname for most cases,
				// but here that would produce "Robert set their display
				// name to Robert" since the new name *is* the new subject.
				// Fall back to the matrix ID (stateKey) so the notice
				// reads "@robert:test set their display name to Robert".
				return {
					text: `${stateKey} set their display name to ${newName}`,
					icon: "info",
				};
			}
			if (oldName) {
				return { text: `${oldName} removed their display name`, icon: "info" };
			}
		}
		const oldAvatar =
			typeof prev.avatar_url === "string" ? prev.avatar_url : "";
		const newAvatar =
			typeof content.avatar_url === "string" ? content.avatar_url : "";
		if (oldAvatar !== newAvatar) {
			if (!oldAvatar && newAvatar)
				return { text: `${subject} set their avatar`, icon: "info" };
			if (oldAvatar && !newAvatar)
				return { text: `${subject} removed their avatar`, icon: "info" };
			return { text: `${subject} changed their avatar`, icon: "info" };
		}
		return null;
	}

	if (membership === "join") {
		return { text: `${subject} joined the room`, icon: "join" };
	}
	if (membership === "leave") {
		if (prevMembership === "invite") {
			if (sender === stateKey) {
				return { text: `${subject} rejected the invite`, icon: "info" };
			}
			return {
				text: `${actor} withdrew the invite to ${subject}`,
				icon: "info",
			};
		}
		if (prevMembership === "ban") {
			return { text: `${subject} was unbanned by ${actor}`, icon: "info" };
		}
		if (sender === stateKey) {
			return { text: `${subject} left the room`, icon: "leave" };
		}
		return { text: `${subject} was removed by ${actor}`, icon: "leave" };
	}
	if (membership === "ban") {
		return { text: `${subject} was banned by ${actor}`, icon: "leave" };
	}
	if (membership === "invite") {
		return { text: `${actor} invited ${subject}`, icon: "join" };
	}
	if (membership === "knock") {
		return { text: `${subject} requested to join`, icon: "info" };
	}
	return null;
}

export function buildStateNotice(
	event: MatrixEvent,
	room: Room,
): StateNotice | null {
	const type = event.getType();
	if (!STATE_NOTICE_TYPES.has(type)) return null;
	// Redacted state events have empty content — nothing meaningful to
	// render. Defer to the existing redaction handling for messages.
	if (typeof event.isRedacted === "function" && event.isRedacted()) {
		return null;
	}
	if (type === "m.room.member") {
		return memberNotice(event, room);
	}
	if (type === CALL_MEMBER_EVENT_TYPE) {
		return callMemberNotice(event, room);
	}
	const content = event.getContent() as Record<string, unknown>;
	const prev = getPrevContent(event);
	const actor = actorName(event, room);
	if (type === "m.room.name") {
		const oldName = typeof prev.name === "string" ? prev.name.trim() : "";
		const newName = typeof content.name === "string" ? content.name.trim() : "";
		if (oldName === newName) return null;
		if (!newName) {
			return { text: `${actor} removed the room name`, icon: "info" };
		}
		return {
			text: `${actor} changed the room name to ${quoted(newName)}`,
			icon: "info",
		};
	}
	if (type === "m.room.topic") {
		const oldTopic = typeof prev.topic === "string" ? prev.topic.trim() : "";
		const newTopic =
			typeof content.topic === "string" ? content.topic.trim() : "";
		if (oldTopic === newTopic) return null;
		if (!newTopic) {
			return { text: `${actor} removed the topic`, icon: "info" };
		}
		return {
			text: `${actor} changed the topic to ${quoted(newTopic)}`,
			icon: "info",
		};
	}
	if (type === "m.room.avatar") {
		const oldUrl = typeof prev.url === "string" ? prev.url : "";
		const newUrl = typeof content.url === "string" ? content.url : "";
		if (oldUrl === newUrl) return null;
		if (!newUrl)
			return { text: `${actor} removed the room avatar`, icon: "info" };
		if (!oldUrl) return { text: `${actor} set the room avatar`, icon: "info" };
		return { text: `${actor} changed the room avatar`, icon: "info" };
	}
	if (type === "m.room.encryption") {
		// The algorithm can be re-set; only emit once per actual transition.
		const oldAlg = typeof prev.algorithm === "string" ? prev.algorithm : "";
		const newAlg =
			typeof content.algorithm === "string" ? content.algorithm : "";
		if (!newAlg) return null;
		if (oldAlg && oldAlg === newAlg) return null;
		return { text: "Encryption was enabled", icon: "info" };
	}
	if (type === "m.room.canonical_alias") {
		const oldAlias = typeof prev.alias === "string" ? prev.alias.trim() : "";
		const newAlias =
			typeof content.alias === "string" ? content.alias.trim() : "";
		if (oldAlias === newAlias) return null;
		if (!newAlias) {
			return { text: `${actor} removed the main address`, icon: "info" };
		}
		return {
			text: `${actor} set the main address to ${newAlias}`,
			icon: "info",
		};
	}
	if (type === "m.room.tombstone") {
		const reason = typeof content.body === "string" ? content.body.trim() : "";
		return {
			text: reason
				? `This room has been upgraded: ${reason}`
				: "This room has been upgraded",
			icon: "info",
		};
	}
	return null;
}

function memberAvatarUrl(
	client: MatrixClient,
	room: Room,
	stateKey: string,
	content: Record<string, unknown>,
	prev: Record<string, unknown>,
): string | null {
	// Prefer the avatar carried by the event itself (new for join/invite,
	// previous for leave/kick/ban where the affected user may have left and
	// `room.getMember` would return null), then fall back to current state.
	const fromContent =
		typeof content.avatar_url === "string" ? content.avatar_url : "";
	const fromPrev = typeof prev.avatar_url === "string" ? prev.avatar_url : "";
	const fromMember = room.getMember(stateKey)?.getMxcAvatarUrl?.() ?? "";
	const mxc = fromContent || fromPrev || fromMember;
	if (!mxc) return null;
	return client.mxcUrlToHttp(mxc, 48, 48, "crop") ?? null;
}

/**
 * Avatar URL for a call-member transition's subject. Call-member events
 * don't carry profile data, so resolve the sender's avatar from current
 * room state (null when the member or avatar is unknown).
 */
function callMemberAvatarUrl(
	client: MatrixClient,
	room: Room,
	sender: string,
): string | null {
	const mxc = room.getMember(sender)?.getMxcAvatarUrl?.() ?? "";
	if (!mxc) return null;
	return client.mxcUrlToHttp(mxc, 48, 48, "crop") ?? null;
}

/**
 * Classify an `m.room.member` (or MatrixRTC call-member) event as a grouping
 * membership transition, or null when it should not group (non-member event,
 * profile-only change while joined, invite withdrawal/rejection, unban, or a
 * call-membership refresh that is not a join/leave). Used by the timeline to
 * collapse consecutive same-kind transitions into one notice.
 */
export function buildMembershipTransition(
	event: MatrixEvent,
	room: Room,
	client: MatrixClient,
): MembershipTransition | null {
	if (event.getType() === CALL_MEMBER_EVENT_TYPE) {
		const transition = classifyCallTransition(event);
		if (!transition) return null;
		const sender = event.getSender() ?? "";
		// No sender → no identifiable participant; skip (mirrors summaries.ts
		// and keeps grouping dedupe from colliding on an empty userId).
		if (!sender) return null;
		return {
			kind: transition,
			userId: sender,
			subject: actorName(event, room),
			avatarUrl: callMemberAvatarUrl(client, room, sender),
		};
	}
	if (event.getType() !== "m.room.member") return null;
	const stateKey =
		typeof event.getStateKey === "function" ? (event.getStateKey() ?? "") : "";
	if (!stateKey) return null;
	const content = event.getContent() as Record<string, unknown>;
	const prev = getPrevContent(event);
	const membership =
		typeof content.membership === "string" ? content.membership : "leave";
	const prevMembership =
		typeof prev.membership === "string" ? prev.membership : "leave";
	const sender = event.getSender() ?? "";

	let kind: MembershipTransitionKind | null = null;
	if (membership === "join") {
		// Profile-only updates (join->join) are not membership transitions.
		if (prevMembership === "join") return null;
		kind = "join";
	} else if (membership === "invite") {
		kind = "invite";
	} else if (membership === "ban") {
		kind = "ban";
	} else if (membership === "leave") {
		// Invite withdrawal/rejection and unban are distinct transitions that
		// stay individual; only voluntary leaves and kicks group.
		if (prevMembership === "invite" || prevMembership === "ban") return null;
		kind = sender === stateKey ? "leave" : "kick";
	}
	if (!kind) return null;

	return {
		kind,
		userId: stateKey,
		subject: memberSubjectName(room, stateKey, content, prev),
		avatarUrl: memberAvatarUrl(client, room, stateKey, content, prev),
	};
}
