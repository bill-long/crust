import type { MatrixClient, RoomMember } from "matrix-js-sdk";
import { type Accessor, createMemo, createSignal } from "solid-js";
import { createPicker } from "../../../components/picker/Picker";
import { displayNameOr } from "../../../lib/displayName";
import { stripCodeRegions } from "../../../lib/extractUrls";
import type { Mention } from "../../../lib/markdown";

/**
 * Sentinel autocomplete entry for the `@room` everyone-mention (#448). A
 * module-level singleton so the picker's reference-keyed rows stay stable
 * across keystrokes, and so a type guard can tell it apart from the raw
 * `RoomMember` references the member rows keep (wrapping members would
 * re-mint every row per keystroke).
 */
export const ROOM_MENTION_CANDIDATE = Object.freeze({
	roomMention: true as const,
});

export type MentionCandidate = RoomMember | typeof ROOM_MENTION_CANDIDATE;

export function isRoomMentionCandidate(
	candidate: MentionCandidate,
): candidate is typeof ROOM_MENTION_CANDIDATE {
	return candidate === ROOM_MENTION_CANDIDATE;
}

/** Whether `token` occurs in `stripped` with word boundaries on both sides. */
function hasBoundedToken(stripped: string, token: string): boolean {
	let searchFrom = 0;
	while (searchFrom < stripped.length) {
		const idx = stripped.indexOf(token, searchFrom);
		if (idx < 0) return false;
		const beforeOk = idx === 0 || !/\w/.test(stripped.charAt(idx - 1));
		const afterIdx = idx + token.length;
		const afterOk =
			afterIdx >= stripped.length || !/\w/.test(stripped.charAt(afterIdx));
		if (beforeOk && afterOk) return true;
		searchFrom = idx + 1;
	}
	return false;
}

/**
 * Whether `msg` contains a boundary-checked `@room` token outside code -
 * the same rule the reconcilers apply. Exported for the composer's
 * edit-mode seeding (a kept token plus the target's `room:true` re-arms
 * the intent).
 */
export function hasRoomMentionToken(msg: string): boolean {
	return hasBoundedToken(stripCodeRegions(msg), "@room");
}

interface UseMentionsDeps {
	client: MatrixClient;
	roomId: Accessor<string>;
	/** Live getter for the composer textarea (a `let` ref in the caller). */
	getTextarea: () => HTMLTextAreaElement | undefined;
	text: Accessor<string>;
	setText: (value: string) => void;
	autoResize: () => void;
}

/**
 * @-mention support for the composer: the confirmed mentions list, the active
 * mention query, the member autocomplete picker, and the helpers that detect a
 * mention trigger, reconcile mentions against the current text, and insert a
 * picked member. Reads the live textarea selection and text() at call time and
 * mutates only the mentions/query state and text() - no cross-room state of its
 * own.
 */
export function useMentions(deps: UseMentionsDeps) {
	const [mentions, setMentions] = createSignal<Mention[]>([]);
	const [mentionQuery, setMentionQuery] = createSignal<string | null>(null);
	// The user picked `@room` from the autocomplete and the token is still
	// in the text. Intent-based like user mentions: plain-typed "@room"
	// without a pick does NOT set `m.mentions.room` (matching how a typed
	// @Name without a pick goes out unpilled and unmentioned).
	const [roomMentionIntent, setRoomMentionIntent] = createSignal(false);

	// Mention picker
	const {
		Picker: MentionPicker,
		handlePickerKey,
		getActiveDescendant,
		listboxId,
	} = createPicker<MentionCandidate>();

	const roomMembers = createMemo(() => {
		const room = deps.client.getRoom(deps.roomId());
		return room ? room.getJoinedMembers() : [];
	});

	// Whether the sender's power level may trigger a room notification
	// (`m.room.power_levels` `notifications.room`, default PL 50) - the
	// same SDK check Element gates its @room entry on. Read live per
	// candidate-list computation; like SpaceTile's canInvite this accepts
	// mild staleness (no state-event subscription) since the receivers'
	// clients re-validate the sender's power level anyway.
	const canRoomMention = (): boolean => {
		const room = deps.client.getRoom(deps.roomId());
		const userId = deps.client.getUserId();
		if (!room || !userId) return false;
		return room.currentState.mayTriggerNotifOfType("room", userId);
	};

	// Shared filtered candidate list - used by both picker and ARIA state.
	// Unbounded: the picker windows its rows (VirtualList), so a large match
	// set costs this one filter pass, not DOM nodes - every member stays
	// reachable by scrolling/arrowing instead of being cut at a cap. (The
	// picker itself gets no filterFn, so this is the only per-keystroke pass
	// over the member list.) Names are read live on purpose: the SDK mutates
	// RoomMember.name in place on rename, so any search index cached against
	// the (per-room stable) member-array identity would go stale.
	// The `@room` entry is offered when the query prefixes "room" and the
	// sender may trigger room notifications, but it TRAILS the member
	// matches: the picker's default Enter target is index 0, and the
	// highest-blast-radius candidate must never be one muscle-memory
	// keystroke away when the user meant a member whose name starts with
	// "ro". Member rows keep their raw RoomMember references (see
	// ROOM_MENTION_CANDIDATE).
	const mentionCandidates = createMemo<MentionCandidate[]>(() => {
		const q = mentionQuery();
		if (q === null) return [];
		const lowerQ = q.toLowerCase();
		// Bare '@' matches everyone - skip the per-member lowercasing pass
		// entirely rather than string-matching 2x per member for a foregone
		// conclusion.
		const members =
			lowerQ === ""
				? roomMembers()
				: roomMembers().filter(
						(m) =>
							// Match what the row SHOWS, not the raw name: the picker
							// renders `displayNameOr(...)`, so filtering on the raw
							// value made a row with a stripped direction override
							// vanish as the user typed the characters they could see.
							displayNameOr(m.name, m.userId).toLowerCase().includes(lowerQ) ||
							m.userId.toLowerCase().includes(lowerQ),
					);
		if ("room".startsWith(lowerQ) && canRoomMention()) {
			return [...members, ROOM_MENTION_CANDIDATE];
		}
		return members;
	});

	const pickerRendered = () => mentionCandidates().length > 0;

	function detectMention(currentText?: string): void {
		const el = deps.getTextarea();
		if (!el) return;
		const text = currentText ?? el.value;
		const pos = el.selectionStart;
		const before = text.slice(0, pos);
		// Look for @ at start or after non-word char, capture query after it
		const match = before.match(/(^|[^\w])@(\S*)$/);
		setMentionQuery(match?.[2] ?? null);
		// Disarm a picked @room the moment its token leaves the text, not
		// just at send: a LATER hand-typed @room in the same draft must not
		// ride the stale intent into an everyone-ping (user mentions accept
		// the analogous re-type - a re-typed @Name still denotes that
		// person - but a re-typed @room is plausibly quotation, with
		// room-wide blast radius).
		if (
			roomMentionIntent() &&
			!hasBoundedToken(stripCodeRegions(text), "@room")
		) {
			setRoomMentionIntent(false);
		}
	}

	/** Prune mentions whose @DisplayName is no longer in non-code text */
	function reconcileMentions(msg: string): Mention[] {
		const stripped = stripCodeRegions(msg);
		return mentions().filter((m) =>
			hasBoundedToken(stripped, `@${m.displayName}`),
		);
	}

	/**
	 * Whether the send should carry `m.mentions.room`: the user picked the
	 * `@room` entry AND its token is still present in non-code text (same
	 * prune rule as user mentions).
	 */
	function reconcileRoomMention(msg: string): boolean {
		return (
			roomMentionIntent() && hasBoundedToken(stripCodeRegions(msg), "@room")
		);
	}

	/** Normalize a display name for insertion: strip the leading @ of a
	 *  userId-shaped fallback to avoid `@@user:server`. A member literally
	 *  named "room" falls back to their user-id form - their token must
	 *  never collide with the @room everyone-mention token (both
	 *  reconcilers would match the same "@room" text and double-emit). */
	function insertableName(rawName: string, userId: string): string {
		// Through the policy first: this string is spliced into the message
		// body, so a newline would split the body and `reconcileMentions`
		// could no longer match the token - the mention would send unpilled,
		// with no push for the person named.
		const resolved = displayNameOr(rawName, userId);
		const name = resolved.startsWith("@") ? resolved.slice(1) : resolved;
		return name === "room" ? userId.replace(/^@/, "") : name;
	}

	/** Record a mention, deduped by userId. On a dedupe hit the stored
	 *  displayName is UPDATED to the just-inserted one - the entry must
	 *  match the token now in the text, or reconcileMentions prunes it at
	 *  send and the mention goes out unpilled (a rename between two
	 *  inserts of the same user would otherwise strand the old name). */
	function commitMention(userId: string, displayName: string): void {
		setMentions((prev) => {
			const existing = prev.findIndex((m) => m.userId === userId);
			if (existing < 0) return [...prev, { userId, displayName }];
			const current = prev[existing];
			if (current === undefined) return [...prev, { userId, displayName }];
			if (current.displayName === displayName) return prev;
			const next = [...prev];
			next[existing] = { userId, displayName };
			return next;
		});
	}

	/** Move the caret past the insertion and refocus the textarea. */
	function placeCaretAfter(position: number): void {
		requestAnimationFrame(() => {
			const ta = deps.getTextarea();
			if (!ta) return;
			ta.setSelectionRange(position, position);
			ta.focus();
			deps.autoResize();
		});
	}

	function onMentionSelect(candidate: MentionCandidate): void {
		const el = deps.getTextarea();
		if (!el) return;
		const pos = el.selectionStart;
		const currentText = deps.text();
		const before = currentText.slice(0, pos);
		// Use same regex as detectMention to find the triggering @
		const triggerMatch = before.match(/(^|[^\w])@(\S*)$/);
		const triggerQuery = triggerMatch?.[2];
		if (triggerQuery === undefined) return;
		const atIdx = before.length - triggerQuery.length - 1;

		const displayName = isRoomMentionCandidate(candidate)
			? "room"
			: insertableName(candidate.name ?? "", candidate.userId);
		const insertion = `@${displayName} `;
		// Replace the entire @partial token (from @ through any non-whitespace after caret)
		const afterCaret = currentText.slice(pos);
		const trailingQuery = afterCaret.match(/^\S*/)?.[0] ?? "";
		const after = currentText.slice(pos + trailingQuery.length);
		const newText = currentText.slice(0, atIdx) + insertion + after;

		deps.setText(newText);
		setMentionQuery(null);
		if (isRoomMentionCandidate(candidate)) {
			setRoomMentionIntent(true);
		} else {
			commitMention(candidate.userId, displayName);
		}
		placeCaretAfter(atIdx + insertion.length);
	}

	/**
	 * Insert `@DisplayName ` at the caret without an @-trigger in the text
	 * (the profile card's "Mention" action). Pads with a leading space when
	 * the caret follows a non-whitespace character, mirrors
	 * {@link onMentionSelect}'s dedupe and caret handling.
	 */
	function insertMention(userId: string, rawName: string): void {
		const el = deps.getTextarea();
		const currentText = deps.text();
		// Trust the caret only while the textarea is actually focused: an
		// unfocused textarea whose value was set programmatically (restored
		// draft) reports a stale selectionStart, which would splice the
		// mention mid-sentence instead of appending.
		const pos =
			el && document.activeElement === el
				? el.selectionStart
				: currentText.length;
		const before = currentText.slice(0, pos);
		const displayName = insertableName(rawName, userId);
		const pad = before.length === 0 || /\s$/.test(before) ? "" : " ";
		const insertion = `${pad}@${displayName} `;
		deps.setText(before + insertion + currentText.slice(pos));
		commitMention(userId, displayName);
		placeCaretAfter(pos + insertion.length);
	}

	/**
	 * Clear every piece of mention state in one call. The reset sites in
	 * the composer (send, edit entry/exit) must never clear the user
	 * mentions but forget the @room intent - a stale intent leaking onto
	 * an unrelated later message is this feature's worst failure mode.
	 */
	function resetMentionState(): void {
		setMentions([]);
		setRoomMentionIntent(false);
		setMentionQuery(null);
	}

	return {
		mentions,
		setMentions,
		mentionQuery,
		setMentionQuery,
		roomMentionIntent,
		setRoomMentionIntent,
		resetMentionState,
		MentionPicker,
		handlePickerKey,
		getActiveDescendant,
		listboxId,
		mentionCandidates,
		pickerRendered,
		detectMention,
		reconcileMentions,
		reconcileRoomMention,
		onMentionSelect,
		insertMention,
	};
}
