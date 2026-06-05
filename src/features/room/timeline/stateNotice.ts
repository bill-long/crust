import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";

/**
 * Derived text for a non-message state event (m.room.member, m.room.name,
 * etc.), rendered as a compact one-line notice in the timeline. Mirrors
 * what Element / Cinny / Discord show for the same events. Returns null
 * when the event carries no user-visible change (e.g. join->join with
 * identical profile, no-op topic write).
 */
export interface StateNotice {
	text: string;
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
	| "ban";

export interface MembershipTransition {
	kind: MembershipTransitionKind;
	/** Matrix user ID of the affected member (the event's state_key). */
	userId: string;
	/** Display name of the affected user (the member event's state_key). */
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
				return { text: `${oldName} changed their name to ${newName}` };
			}
			if (newName) {
				// Subject derives from content.displayname for most cases,
				// but here that would produce "Robert set their display
				// name to Robert" since the new name *is* the new subject.
				// Fall back to the matrix ID (stateKey) so the notice
				// reads "@robert:test set their display name to Robert".
				return {
					text: `${stateKey} set their display name to ${newName}`,
				};
			}
			if (oldName) {
				return { text: `${oldName} removed their display name` };
			}
		}
		const oldAvatar =
			typeof prev.avatar_url === "string" ? prev.avatar_url : "";
		const newAvatar =
			typeof content.avatar_url === "string" ? content.avatar_url : "";
		if (oldAvatar !== newAvatar) {
			if (!oldAvatar && newAvatar)
				return { text: `${subject} set their avatar` };
			if (oldAvatar && !newAvatar)
				return { text: `${subject} removed their avatar` };
			return { text: `${subject} changed their avatar` };
		}
		return null;
	}

	if (membership === "join") {
		return { text: `${subject} joined the room` };
	}
	if (membership === "leave") {
		if (prevMembership === "invite") {
			if (sender === stateKey) {
				return { text: `${subject} rejected the invite` };
			}
			return { text: `${actor} withdrew the invite to ${subject}` };
		}
		if (prevMembership === "ban") {
			return { text: `${subject} was unbanned by ${actor}` };
		}
		if (sender === stateKey) {
			return { text: `${subject} left the room` };
		}
		return { text: `${subject} was removed by ${actor}` };
	}
	if (membership === "ban") {
		return { text: `${subject} was banned by ${actor}` };
	}
	if (membership === "invite") {
		return { text: `${actor} invited ${subject}` };
	}
	if (membership === "knock") {
		return { text: `${subject} requested to join` };
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
	const content = event.getContent() as Record<string, unknown>;
	const prev = getPrevContent(event);
	const actor = actorName(event, room);
	if (type === "m.room.name") {
		const oldName = typeof prev.name === "string" ? prev.name.trim() : "";
		const newName = typeof content.name === "string" ? content.name.trim() : "";
		if (oldName === newName) return null;
		if (!newName) {
			return { text: `${actor} removed the room name` };
		}
		return { text: `${actor} changed the room name to ${quoted(newName)}` };
	}
	if (type === "m.room.topic") {
		const oldTopic = typeof prev.topic === "string" ? prev.topic.trim() : "";
		const newTopic =
			typeof content.topic === "string" ? content.topic.trim() : "";
		if (oldTopic === newTopic) return null;
		if (!newTopic) {
			return { text: `${actor} removed the topic` };
		}
		return { text: `${actor} changed the topic to ${quoted(newTopic)}` };
	}
	if (type === "m.room.avatar") {
		const oldUrl = typeof prev.url === "string" ? prev.url : "";
		const newUrl = typeof content.url === "string" ? content.url : "";
		if (oldUrl === newUrl) return null;
		if (!newUrl) return { text: `${actor} removed the room avatar` };
		if (!oldUrl) return { text: `${actor} set the room avatar` };
		return { text: `${actor} changed the room avatar` };
	}
	if (type === "m.room.encryption") {
		// The algorithm can be re-set; only emit once per actual transition.
		const oldAlg = typeof prev.algorithm === "string" ? prev.algorithm : "";
		const newAlg =
			typeof content.algorithm === "string" ? content.algorithm : "";
		if (!newAlg) return null;
		if (oldAlg && oldAlg === newAlg) return null;
		return { text: "Encryption was enabled" };
	}
	if (type === "m.room.canonical_alias") {
		const oldAlias = typeof prev.alias === "string" ? prev.alias.trim() : "";
		const newAlias =
			typeof content.alias === "string" ? content.alias.trim() : "";
		if (oldAlias === newAlias) return null;
		if (!newAlias) {
			return { text: `${actor} removed the main address` };
		}
		return { text: `${actor} set the main address to ${newAlias}` };
	}
	if (type === "m.room.tombstone") {
		const reason = typeof content.body === "string" ? content.body.trim() : "";
		return {
			text: reason
				? `This room has been upgraded: ${reason}`
				: "This room has been upgraded",
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
 * Classify an `m.room.member` event as a grouping membership transition, or
 * null when it should not group (non-member event, profile-only change while
 * joined, invite withdrawal/rejection, or unban). Used by the timeline to
 * collapse consecutive same-kind transitions into one notice.
 */
export function buildMembershipTransition(
	event: MatrixEvent,
	room: Room,
	client: MatrixClient,
): MembershipTransition | null {
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
