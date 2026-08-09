import type { Room } from "matrix-js-sdk";

/** Display data for a pending invite, derived from the invited user's own
 *  m.room.member event (delivered in the invite's stripped state). */
export interface InviteDetails {
	/** MXID of the user who sent the invite, or null when unknown. */
	inviterId: string | null;
	/** Inviter's display name, falling back to their MXID. */
	inviterName: string | null;
	/** Optional human-written invite reason (member event `reason`). */
	reason: string | null;
	/** True when the invite marks the room as a direct message. */
	isDirect: boolean;
}

/**
 * Derive who invited `myUserId` to `room` (and why) from the invite member
 * event. All fields are best-effort: stripped invite state is
 * server-controlled and may omit any of them.
 */
export function getInviteDetails(room: Room, myUserId: string): InviteDetails {
	const memberEvent = room.getMember(myUserId)?.events.member;
	const inviterId = memberEvent?.getSender() ?? null;
	const content = memberEvent?.getContent();
	const reason =
		content && typeof content.reason === "string" && content.reason.trim()
			? content.reason
			: null;
	const inviterName = inviterId
		? (room.getMember(inviterId)?.name ?? inviterId)
		: null;
	return {
		inviterId,
		inviterName,
		reason,
		isDirect: content?.is_direct === true,
	};
}
