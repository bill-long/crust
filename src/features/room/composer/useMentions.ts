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

	const MAX_PICKER_RESULTS = 50;

	// Shared filtered member list - used by both picker and ARIA state
	const filteredMembers = createMemo(() => {
		const q = mentionQuery();
		if (q === null) return [];
		const lowerQ = q.toLowerCase();
		const results: RoomMember[] = [];
		for (const m of roomMembers()) {
			const name = (m.name ?? "").toLowerCase();
			const uid = m.userId.toLowerCase();
			if (name.includes(lowerQ) || uid.includes(lowerQ)) {
				results.push(m);
				if (results.length >= MAX_PICKER_RESULTS) break;
			}
		}
		return results;
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

		const rawName = member.name?.trim() || member.userId;
		// Strip leading @ from userId fallback to avoid @@user:server
		const displayName = rawName.startsWith("@") ? rawName.slice(1) : rawName;
		const insertion = `@${displayName} `;
		// Replace the entire @partial token (from @ through any non-whitespace after caret)
		const afterCaret = currentText.slice(pos);
		const trailingQuery = afterCaret.match(/^\S*/)?.[0] ?? "";
		const after = currentText.slice(pos + trailingQuery.length);
		const newText = currentText.slice(0, atIdx) + insertion + after;

		deps.setText(newText);
		setMentionQuery(null);

		// Add to mentions list (deduplicate by userId)
		setMentions((prev) => {
			if (prev.some((m) => m.userId === member.userId)) return prev;
			return [...prev, { userId: member.userId, displayName }];
		});

		// Move caret after inserted mention
		requestAnimationFrame(() => {
			const ta = deps.getTextarea();
			if (!ta) return;
			const newPos = atIdx + insertion.length;
			ta.setSelectionRange(newPos, newPos);
			ta.focus();
			deps.autoResize();
		});
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
	};
}
