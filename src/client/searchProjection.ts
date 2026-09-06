import type { MatrixEvent, Room } from "matrix-js-sdk";
import { displayNameOr } from "../lib/displayName";
import { TEXT_MSGTYPES } from "../lib/msgtypes";
import type { SearchHit } from "../lib/searchHit";
import { threadJumpTarget } from "../lib/threadEvents";

/**
 * Turn a timeline event into a search hit, or `null` if it is not something
 * search should surface.
 *
 * In `client/` rather than beside either search panel: the per-room panel and
 * the global one must agree on what counts as a result, and a feature may not
 * reach into another feature's modules to share it (AGENTS.md).
 *
 * Excluded: redactions (no body left to show), edit events (`m.replace` -
 * the edit's own body is shown through the original), non-text msgtypes, and
 * anything with an empty body.
 */
export function projectEvent(
	room: Room | null,
	ev: MatrixEvent,
): SearchHit | null {
	const id = ev.getId();
	if (!id) return null;
	if (ev.isRedacted()) return null;
	const content = (ev.getContent?.() ?? {}) as Record<string, unknown>;
	const relates = content["m.relates_to"] as { rel_type?: string } | undefined;
	if (relates?.rel_type === "m.replace") return null;
	// Thread replies aren't part of the main timeline, but they ARE
	// searchable: carry the root id so the jump opens the thread panel
	// instead of the (doomed) main-timeline anchor (issue #334).
	const threadRootId = threadJumpTarget(ev);
	const body = typeof content.body === "string" ? content.body : "";
	if (!body) return null;
	const msgtype = typeof content.msgtype === "string" ? content.msgtype : "";
	if (!TEXT_MSGTYPES.has(msgtype)) {
		return null;
	}
	const sender = ev.getSender() ?? "";
	const member = sender && room ? room.getMember(sender) : null;
	return {
		eventId: id,
		sender,
		senderName: displayNameOr(member?.name, sender),
		timestamp: ev.getTs?.() ?? 0,
		body,
		...(threadRootId !== undefined ? { threadRootId } : {}),
	};
}
