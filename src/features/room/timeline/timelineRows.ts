import { isDifferentDay, isSameDay } from "./dateFormatting";
import type { TimelineEvent } from "./useTimeline";

export const MESSAGE_GROUP_GAP_MS = 7 * 60 * 1000; // 7 minutes

/** Whether a message should show the full header (avatar + name + time). */
export function shouldShowHeader(
	events: readonly TimelineEvent[],
	index: number,
	firstUnreadEventId: string | null,
): boolean {
	const curr = events[index];
	if (!curr) return true;
	// State notices render as a compact one-liner without an avatar or
	// header — and a regular message immediately after a notice should
	// always show its own header so the grouping doesn't span the
	// notice.
	if (curr.stateNotice) return false;
	// Emotes render as a self-identifying "* Name action" line (#448), so
	// a separate avatar+name header would just double the name. Mirrors
	// the state-notice rule: the emote shows no header, and the message
	// after it always reintroduces its own.
	if (curr.msgtype === "m.emote") return false;
	// Break the group at the unread divider, for the same reason the day
	// boundary breaks it: the divider lands between the two halves, and a
	// headerless continuation row under it reads as an orphan - a red rule
	// followed by a bare line with no avatar or name. Below the notice and
	// emote rules deliberately: those rows identify their own sender, so
	// forcing a header on them would print the name twice.
	if (curr.eventId === firstUnreadEventId) return true;
	if (index === 0) return true;
	const prev = events[index - 1];
	if (!prev) return true;
	if (prev.stateNotice) return true;
	if (prev.msgtype === "m.emote") return true;
	if (prev.senderId !== curr.senderId) return true;
	if (curr.timestamp - prev.timestamp > MESSAGE_GROUP_GAP_MS) return true;
	// Break group on day boundary so the date separator can land cleanly
	// between the two halves.
	if (!isSameDay(prev.timestamp, curr.timestamp)) return true;
	return false;
}

/**
 * Whether a row displays its own date.
 *
 * The date lives inline in the group header (`formatHeaderTimestamp`), so a
 * row shows its date exactly when it renders that header. `shouldShowHeader`
 * already returns false for the row kinds that render without one - state
 * notices and emotes - so this only adds the case it does not model: a
 * blocked sender's message, which renders a "message hidden" placeholder
 * carrying no timestamp.
 *
 * Collapsed membership runs need no check of their own. A row only joins a
 * run when its `membershipTransition` is set, and that implies `stateNotice`
 * is set too (see `timelineTypes.ts`) - so `shouldShowHeader` has already
 * returned false, whether the row renders as the run's
 * `GroupedMembershipNotice` summary or as a hidden member.
 */
export function rowShowsOwnDate(
	events: readonly TimelineEvent[],
	index: number,
	firstUnreadEventId: string | null,
	isSenderIgnored: boolean,
): boolean {
	if (isSenderIgnored) return false;
	return shouldShowHeader(events, index, firstUnreadEventId);
}

/**
 * How to draw the day boundary above a row.
 *
 * - `"none"`  - draw nothing.
 * - `"rule"`  - a bare hairline. The row below states its own date, so
 *               labelling the boundary too would be redundant.
 * - `"labeled"` - hairline plus a visible date. The row below cannot state
 *               its own date, so this is the only place it can appear.
 *
 * The invariant: **a day boundary always makes its date visible somewhere**,
 * either on the boundary itself or on the row directly under it. `"rule"` is
 * only ever chosen when `rowShowsOwnDate` has confirmed the latter.
 *
 * Index 0 is the top of the loaded scrollback rather than a real day
 * boundary, so it gets no rule - only a label, and only when the first row
 * cannot date itself.
 */
export type DateSeparatorMode = "none" | "rule" | "labeled";

export function dateSeparatorMode(
	events: readonly TimelineEvent[],
	index: number,
	firstUnreadEventId: string | null,
	isSenderIgnored: boolean,
): DateSeparatorMode {
	const curr = events[index];
	if (!curr) return "none";
	const dated = rowShowsOwnDate(
		events,
		index,
		firstUnreadEventId,
		isSenderIgnored,
	);
	if (index === 0) return dated ? "none" : "labeled";
	const prev = events[index - 1];
	if (!prev) return "none";
	if (!isDifferentDay(prev.timestamp, curr.timestamp)) return "none";
	return dated ? "rule" : "labeled";
}
