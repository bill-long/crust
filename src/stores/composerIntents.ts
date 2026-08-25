import { createSignal } from "solid-js";

/**
 * A request from outside the composer (the profile card's "Mention"
 * action) to insert an @-mention at the caret of the composer editing
 * `roomId`/`threadRootId`. Store-driven like `joinDialog`: the profile
 * card and the composer are far apart in the tree, and the composer
 * owns all text/mention state, so the intent crosses via this signal
 * and the matching composer consumes it.
 */
export interface MentionIntent {
	roomId: string;
	/** Thread-panel composer target; null targets the room composer. */
	threadRootId: string | null;
	userId: string;
	/** Raw display name (or user ID) - the composer normalizes it. */
	name: string;
	/** Stamped at request time; see {@link MENTION_INTENT_TTL_MS}. */
	at: number;
}

/**
 * An intent is only valid for the gesture that fired it. If no matching
 * composer was mounted to consume it (a thread panel closing in the same
 * tick), it must not replay into a composer mounted much later - the
 * consumer drops anything older than this.
 */
export const MENTION_INTENT_TTL_MS = 5_000;

const [mentionIntent, setMentionIntent] = createSignal<MentionIntent | null>(
	null,
);

export { mentionIntent };

export function requestMention(intent: Omit<MentionIntent, "at">): void {
	// A fresh object every call: the consumer clears the signal after
	// handling, and a new reference retriggers even an identical payload.
	setMentionIntent({ ...intent, at: Date.now() });
}

/**
 * Consume the pending intent. The matching composer calls this after
 * inserting so a later remount of the same room's composer (room
 * switch and back) doesn't replay a stale intent.
 */
export function clearMentionIntent(): void {
	setMentionIntent(null);
}
