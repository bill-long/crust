import { stripReplyFallback } from "../../../lib/replyFallback";
import { SPOILER_PLACEHOLDER } from "../composer/draftToWire";
import type { TimelineEvent } from "./timelineTypes";

/**
 * Whether `ev` is a message the current user can edit: their own, a text
 * message (`m.text`) or an emote (`m.emote`, the `/me` path), and fully
 * sent.
 *
 * The send-status check matters for the up-arrow shortcut specifically: a
 * just-sent message that's still a local echo has no real event id yet, so an
 * `m.replace` targeting it would silently fail to apply. This is deliberately
 * stricter than the per-message Edit button (which also renders on an in-flight
 * echo) because the shortcut fires the instant the composer empties, right when
 * an echo is most likely still in flight.
 */
export function isEditableEvent(ev: TimelineEvent, myUserId: string): boolean {
	return (
		ev.senderId === myUserId && isEditableContent(ev) && ev.status === null
	);
}

/**
 * Content-level editability: a text-like msgtype whose body can prefill
 * an edit draft without losing content. Shared by {@link isEditableEvent}
 * and the hover toolbar's Edit gate so the two rules can't drift (the
 * ownership/send-status clauses stay per call site).
 */
export function isEditableContent(ev: TimelineEvent): boolean {
	return (
		(ev.msgtype === "m.text" || ev.msgtype === "m.emote") &&
		!bodyIsSpoilerPlaceholder(ev)
	);
}

/**
 * True when `ev.body` is a /spoiler placeholder that doesn't carry the
 * message's real text (which lives only in formatted_body per MSC2010) -
 * possibly behind a reply fallback, which a reply's wire body prepends.
 * Any body-derived surface (edit prefill, copy text) would produce the
 * literal placeholder instead of the content, so those affordances gate
 * on this.
 */
export function bodyIsSpoilerPlaceholder(ev: TimelineEvent): boolean {
	// formattedBody first: it short-circuits the regex work for the vast
	// majority of messages (and for partial test fixtures without a body).
	return (
		(ev.formattedBody?.includes("data-mx-spoiler") ?? false) &&
		stripReplyFallback(ev.body).trim() === SPOILER_PLACEHOLDER
	);
}

/**
 * Resolve the target for the "up-arrow in an empty composer edits the last
 * message" shortcut: the user's single most recent message, returned only if it
 * is {@link isEditableEvent}.
 *
 * Crucially this does NOT hunt backward past the user's own non-editable
 * *message* tail. If their latest message is an image or a still
 * in-flight echo, the shortcut no-ops (returns `null`) rather than silently
 * jumping to an older message and editing the wrong one. The user's own
 * non-message rows (membership / state notices like a display-name or avatar
 * change) are skipped - they aren't messages, so they must not count as "the
 * last message" and block the shortcut. Other users' messages after the user's
 * latest are skipped over too (so "edit my last" still works when others have
 * posted since). Redacted events and `m.replace` edits are already absent from
 * the displayed `events` store.
 */
export function findLastEditableEvent(
	events: readonly TimelineEvent[],
	myUserId: string,
): TimelineEvent | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const ev = events[i];
		if (ev === undefined) continue;
		if (ev.senderId !== myUserId) continue;
		// Own membership/state notice: not a message, skip past it.
		if (ev.stateNotice !== null) continue;
		return isEditableEvent(ev, myUserId) ? ev : null;
	}
	return null;
}
