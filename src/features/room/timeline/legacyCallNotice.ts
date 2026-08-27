import type { MatrixEvent, Room } from "matrix-js-sdk";
import { noticeActorName, type StateNotice } from "./stateNotice";

/**
 * The legacy 1:1 call invite (MSC2746 and its predecessors), as sent by
 * Element and other clients that still ring over `m.call.*`.
 *
 * Crust is MatrixRTC/LiveKit-only by design and legacy call *support* is
 * wontfix (#453). This exists only so the resulting silence is legible: a
 * timeline that looks exactly as though nobody ever called is worse than one
 * that says a call came in and could not be taken.
 */
export const LEGACY_CALL_INVITE_TYPE = "m.call.invite";

/**
 * Whether this event type renders as a legacy-call notice.
 *
 * Deliberately just the invite. The rest of the legacy signalling
 * (`m.call.candidates`, `m.call.answer`, `m.call.select_answer`,
 * `m.call.negotiate`, `m.call.hangup`, `m.call.reject`) stays
 * non-displayable: it is machinery for a call this client can never join,
 * and one row per call is the whole point.
 *
 * Separate from `STATE_NOTICE_TYPES` on purpose. Every type in that set is a
 * *state* event and `buildStateNotice` is written against state semantics
 * (`getStateKey`, `prev_content`, "redacted state has nothing to render").
 * An invite is an ordinary timeline event, so folding it in would break that
 * function's invariant rather than extend it.
 */
export function isLegacyCallNoticeType(type: string): boolean {
	return type === LEGACY_CALL_INVITE_TYPE;
}

/**
 * The user an MSC2746 invite was placed to, if it named one. Clients that are
 * not the invitee are meant to ignore the ring entirely.
 */
function invitee(event: MatrixEvent): string | null {
	const raw = (event.getContent() as Record<string, unknown>).invitee;
	return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** The `call_id` that ties one call's signalling together, if it has one. */
function callId(event: MatrixEvent): string | null {
	const raw = (event.getContent() as Record<string, unknown>).call_id;
	return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Invite event IDs that must render no notice, so a call produces exactly one
 * row however many invites carried it.
 *
 * A caller retrying, or re-sending after a glare resolution, repeats the same
 * `call_id`; only the first invite for each one keeps its notice. Invites with
 * no usable `call_id` are left alone here - {@link buildLegacyCallNotice}
 * drops them anyway, and suppressing on a key we could not read would be
 * guessing.
 *
 * Mirrors `computeCallTimelineNotices`'s contract for MatrixRTC membership:
 * a set of event IDs whose call notice is reconciled away.
 */
export function computeLegacyCallSuppressions(
	events: readonly MatrixEvent[],
): Set<string> {
	const suppressed = new Set<string>();
	const seenCalls = new Set<string>();
	for (const event of events) {
		if (event.getType() !== LEGACY_CALL_INVITE_TYPE) continue;
		const eventId = event.getId();
		if (!eventId) continue;
		const call = callId(event);
		if (call === null) continue;
		if (seenCalls.has(call)) {
			suppressed.add(eventId);
			continue;
		}
		seenCalls.add(call);
	}
	return suppressed;
}

/**
 * One-line notice for a legacy call invite, or null when there is nothing
 * renderable - which is what keeps the "every displayable event has text"
 * invariant true for this path too.
 *
 * The wording names the cause without blaming anyone: the caller did nothing
 * wrong, and neither did the user who saw no ring. It offers no answer or
 * call-back affordance on purpose - there is no legacy call stack behind it,
 * and a dead button is worse than the silence this replaces.
 *
 * Every legacy call reads as missed, including one the user declined from
 * another client. Distinguishing them would mean threading a per-event
 * outcome (reconciled against a later `m.call.hangup` / `m.call.reject`)
 * through `isDisplayable` and the projector, for a distinction that is
 * cosmetic when this client could never have answered either way.
 */
export function buildLegacyCallNotice(
	event: MatrixEvent,
	room: Room,
): StateNotice | null {
	if (event.getType() !== LEGACY_CALL_INVITE_TYPE) return null;
	// A redacted invite has no content left to read, so it has no call to
	// describe. Matches buildStateNotice's handling of redacted notices.
	if (typeof event.isRedacted === "function" && event.isRedacted()) return null;
	const sender = event.getSender();
	if (!sender) return null;
	// No call_id means nothing ties this to a call, and the dedupe above
	// cannot key on it either. Treat it as unrenderable rather than emit a
	// row that might double up with a sibling invite.
	if (callId(event) === null) return null;

	if (sender === room.myUserId) {
		return {
			text: "You started a call from another session (unsupported call type)",
			icon: "info",
		};
	}

	const actor = noticeActorName(event, room);
	// An invite can name its target. In a room with more than two people,
	// saying "you missed a call" to everyone who was not called states
	// something untrue - they were never rung. Report the call without
	// claiming it was theirs to answer.
	const target = invitee(event);
	if (target !== null && target !== room.myUserId) {
		return {
			text: `${actor} started a call (unsupported call type)`,
			icon: "info",
		};
	}

	return {
		text: `Missed a call from ${actor} (unsupported call type)`,
		icon: "info",
	};
}
