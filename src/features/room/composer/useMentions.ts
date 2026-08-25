import type { MatrixClient, RoomMember } from "matrix-js-sdk";
import { type Accessor, createMemo, createSignal } from "solid-js";
import { createPicker } from "../../../components/picker/Picker";
import type { Mention } from "../../../lib/markdown";

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

	// Mention picker
	const {
		Picker: MentionPicker,
		handlePickerKey,
		getActiveDescendant,
		listboxId,
	} = createPicker<RoomMember>();

	const roomMembers = createMemo(() => {
		const room = deps.client.getRoom(deps.roomId());
		return room ? room.getJoinedMembers() : [];
	});

	// Shared filtered member list - used by both picker and ARIA state.
	// Unbounded: the picker windows its rows (VirtualList), so a large match
	// set costs this one filter pass, not DOM nodes - every member stays
	// reachable by scrolling/arrowing instead of being cut at a cap. (The
	// picker itself gets no filterFn, so this is the only per-keystroke pass
	// over the member list.) Names are read live on purpose: the SDK mutates
	// RoomMember.name in place on rename, so any search index cached against
	// the (per-room stable) member-array identity would go stale.
	const filteredMembers = createMemo(() => {
		const q = mentionQuery();
		if (q === null) return [];
		const lowerQ = q.toLowerCase();
		// Bare '@' matches everyone - skip the per-member lowercasing pass
		// entirely rather than string-matching 2x per member for a foregone
		// conclusion.
		if (lowerQ === "") return roomMembers();
		return roomMembers().filter(
			(m) =>
				(m.name ?? "").toLowerCase().includes(lowerQ) ||
				m.userId.toLowerCase().includes(lowerQ),
		);
	});

	const pickerRendered = () => filteredMembers().length > 0;

	function detectMention(currentText?: string): void {
		const el = deps.getTextarea();
		if (!el) return;
		const pos = el.selectionStart;
		const before = (currentText ?? el.value).slice(0, pos);
		// Look for @ at start or after non-word char, capture query after it
		const match = before.match(/(^|[^\w])@(\S*)$/);
		if (match) {
			setMentionQuery(match[2]);
		} else {
			setMentionQuery(null);
		}
	}

	/** Prune mentions whose @DisplayName is no longer in non-code text */
	function reconcileMentions(msg: string): Mention[] {
		// Strip code blocks and inline code so mentions inside code don't count
		const stripped = msg
			.replace(/```(?:[^\n]*\n[\s\S]*?```|[\s\S]*?```)/g, "")
			.replace(/`[^`]+`/g, "");
		return mentions().filter((m) => {
			const token = `@${m.displayName}`;
			// Scan all occurrences in stripped text - keep if any has valid word boundaries
			let searchFrom = 0;
			while (searchFrom < stripped.length) {
				const idx = stripped.indexOf(token, searchFrom);
				if (idx < 0) return false;
				const beforeOk = idx === 0 || !/\w/.test(stripped[idx - 1]);
				const afterIdx = idx + token.length;
				const afterOk =
					afterIdx >= stripped.length || !/\w/.test(stripped[afterIdx]);
				if (beforeOk && afterOk) return true;
				searchFrom = idx + 1;
			}
			return false;
		});
	}

	/** Normalize a display name for insertion: strip the leading @ of a
	 *  userId-shaped fallback to avoid `@@user:server`. */
	function insertableName(rawName: string, userId: string): string {
		const trimmed = rawName.trim() || userId;
		return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
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
			if (prev[existing].displayName === displayName) return prev;
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

	function onMentionSelect(member: RoomMember): void {
		const el = deps.getTextarea();
		if (!el) return;
		const pos = el.selectionStart;
		const currentText = deps.text();
		const before = currentText.slice(0, pos);
		// Use same regex as detectMention to find the triggering @
		const triggerMatch = before.match(/(^|[^\w])@(\S*)$/);
		if (!triggerMatch) return;
		const atIdx = before.length - triggerMatch[2].length - 1;

		const displayName = insertableName(member.name ?? "", member.userId);
		const insertion = `@${displayName} `;
		// Replace the entire @partial token (from @ through any non-whitespace after caret)
		const afterCaret = currentText.slice(pos);
		const trailingQuery = afterCaret.match(/^\S*/)?.[0] ?? "";
		const after = currentText.slice(pos + trailingQuery.length);
		const newText = currentText.slice(0, atIdx) + insertion + after;

		deps.setText(newText);
		setMentionQuery(null);
		commitMention(member.userId, displayName);
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

	return {
		mentions,
		setMentions,
		mentionQuery,
		setMentionQuery,
		MentionPicker,
		handlePickerKey,
		getActiveDescendant,
		listboxId,
		filteredMembers,
		pickerRendered,
		detectMention,
		reconcileMentions,
		onMentionSelect,
		insertMention,
	};
}
