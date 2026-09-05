import { replaceControlChars } from "./controlChars";

/**
 * Presence as the UI cares about it. Matrix's wire values are `online`,
 * `unavailable` and `offline`; `unavailable` is what every other client
 * surfaces as "idle", so it is named that here rather than leaving the
 * translation to each render site.
 *
 * `unknown` is distinct from `offline`: we have simply never heard about this
 * user. Rendering it as offline would assert something we do not know, so the
 * indicator is omitted entirely for it.
 */
export type PresenceStatus = "online" | "idle" | "offline" | "unknown";

export interface PresenceInfo {
	status: PresenceStatus;
	/** The user's own status message, or null when they have not set one. */
	statusMsg: string | null;
}

export const UNKNOWN_PRESENCE: PresenceInfo = {
	status: "unknown",
	statusMsg: null,
};

/**
 * Longest a status message may be before it is cut, matching what the profile
 * card and user bar can show without wrapping. Applied on read, so a message
 * set from another client cannot break the layout, and enforced on write by
 * the editor, which refuses to save past it - a longer status set elsewhere
 * prefills over the cap and must be shortened before it can be saved again.
 */
export const MAX_STATUS_MSG_LENGTH = 120;

/**
 * Length of a status message as the cap counts it: code points, not UTF-16
 * units. An `<input maxLength>` counts units, so it would stop an all-emoji
 * status at 60 where {@link MAX_STATUS_MSG_LENGTH} allows 120; the editor
 * counts with this instead and never sets `maxLength`.
 */
export function statusMsgLength(raw: string): number {
	let n = 0;
	for (const _ of raw) n++;
	return n;
}

/**
 * How much of a raw `status_msg` is copied for normalisation, measured from
 * the first non-whitespace character rather than from the start.
 *
 * The value is unbounded on the wire and controlled by any peer sharing a
 * room, and presence re-emits on every sync that mentions them, so the work
 * has to be capped before anything allocates. Far past any real status, and
 * past any plausible run of padding in front of one.
 *
 * What this bounds is the copying: the JS-level per-character rebuild and
 * every intermediate string. The `search` that locates the first
 * non-whitespace character is still O(length) in the worst case - that is
 * the price of being exact about leading padding of any length - but it is a
 * native scan that allocates nothing, which is the part that actually hurt.
 */
const MAX_RAW_STATUS_SCAN = 4096;

/**
 * Whether a single code point is half of a surrogate pair standing alone.
 *
 * `Array.from` splits by code point, so a well-formed pair is one entry of
 * two units; an unpaired half is one entry of one unit in the surrogate
 * range, which renders as a replacement glyph.
 */
function isLoneSurrogate(point: string): boolean {
	if (point.length !== 1) return false;
	const code = point.charCodeAt(0);
	return code >= 0xd800 && code <= 0xdfff;
}

/**
 * Normalise a user-supplied status message for display.
 *
 * This is other people's text rendered in our own chrome, so it gets the same
 * treatment as any other untrusted display string: control characters out
 * (newlines included, so nothing smuggles a multi-line block into a one-line
 * slot), whitespace collapsed, and a length cap. Returns null for anything
 * that normalises to empty, so "has no status" and "set a status of spaces"
 * collapse to the same case.
 */
export function sanitizeStatusMsg(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	// Collapse first, then bound, then do the per-character work.
	//
	// The order matters in both directions. `status_msg` is unbounded on the
	// wire and the SDK re-emits presence on every sync that mentions the
	// user, so running `replaceControlChars` - a character-at-a-time
	// concatenation - over the raw value would cost a megabyte of string
	// building per sync for one peer with a megabyte-long status. But
	// slicing *first* is not equivalent to slicing later: normalisation
	// shrinks the string, so a status padded with a long run of newlines or
	// indentation would spend the whole budget on whitespace and normalise
	// to empty, hiding the text the cap would have kept.
	//
	// Collapsing runs of whitespace up front is a native regex over the
	// whole value - no JS-level concatenation - and removes exactly the
	// padding that causes that, leaving a bounded slice safe to hand to the
	// character loop. Two UTF-16 units per code point is the widest a
	// cap-length prefix can be (a surrogate pair), and the `+ 2` leaves the
	// over-cap test below able to fire even after the lone-surrogate pop:
	// at `+ 1` an all-astral value yields exactly cap-many pairs plus one
	// unpaired half, the half is popped, and the result lands precisely *on*
	// the cap - so the ellipsis never appeared and the overflow was dropped
	// silently. An even bound cannot end in a half-pair it did not start
	// with, and cap-many points hold at most `cap * 2` units, so after a pop
	// there are always more than cap of them.
	//
	// The residual gap is a status padded with hundreds of *non-whitespace*
	// control characters, which no client produces.
	//
	// The collapse is bounded too, but by a window rather than a prefix. It
	// is a native regex, yet it still allocates a copy of whatever it is
	// given, and this runs before the no-op comparison in `applyBatch` - so
	// handing it the raw value costs one peer with a megabyte status a fresh
	// megabyte string on every sync that mentions them, to produce something
	// then discarded as unchanged. A plain prefix is not enough either: it
	// reintroduces the very bug this ordering exists to fix as soon as the
	// padding is longer than the prefix.
	//
	// So: find where the real text starts (a native search, no allocation,
	// and exact for a leading run of any length), then take a generous
	// window from there. What that leaves is interior padding longer than
	// the window: a status of "hello", four thousand spaces, then "world"
	// renders as "hello", even though the normalised value would have fit
	// under the cap whole. Bounding that away exactly would mean scanning
	// for the cap-th non-whitespace character, which is the unbounded scan
	// this exists to avoid - so the window is set far past any real status
	// and the gap is accepted rather than described away.
	const start = raw.search(/\S/);
	if (start === -1) return null;
	const bounded = raw
		.slice(start, start + MAX_RAW_STATUS_SCAN)
		.replace(/\s+/g, " ")
		.slice(0, MAX_STATUS_MSG_LENGTH * 2 + 2);
	// Space, not nothing: stripping a newline outright glues the words on
	// either side of it together. Collapse afterwards so the substitution
	// cannot leave double spaces behind.
	const cleaned = replaceControlChars(bounded, " ").replace(/\s+/g, " ").trim();
	if (cleaned.length === 0) return null;
	// By code point, not UTF-16 unit: slicing mid-surrogate leaves a lone
	// half that renders as a replacement character.
	const points = Array.from(cleaned);
	// A trailing lone surrogate is dropped rather than rendered. The
	// truncation below can never create one - it slices code points, not
	// units - but a value that arrives ending in one, or is cut to one by
	// the bound above, would otherwise fall under the cap and skip that
	// branch entirely, rendering as a replacement glyph.
	const lastPoint = points.at(-1);
	if (lastPoint !== undefined && isLoneSurrogate(lastPoint)) {
		points.pop();
	}
	if (points.length === 0) return null;
	return points.length > MAX_STATUS_MSG_LENGTH
		? `${points.slice(0, MAX_STATUS_MSG_LENGTH - 1).join("")}…`
		: points.join("");
}
