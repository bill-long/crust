import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearMentionIntent,
	consumeMentionIntentFor,
	MENTION_INTENT_TTL_MS,
	mentionIntent,
	requestMention,
} from "./composerIntents";

afterEach(() => {
	clearMentionIntent();
	vi.useRealTimers();
});

describe("consumeMentionIntentFor", () => {
	it("delivers to the matching room composer and consumes once", () => {
		requestMention({
			roomId: "!room:hs",
			threadRootId: null,
			userId: "@alice:hs",
			name: "Alice",
		});
		expect(consumeMentionIntentFor("!room:hs", null)?.userId).toBe("@alice:hs");
		// Consumed: a second matching consumer gets nothing.
		expect(consumeMentionIntentFor("!room:hs", null)).toBeNull();
	});

	it("leaves the intent in place on a room or thread-target mismatch", () => {
		requestMention({
			roomId: "!room:hs",
			threadRootId: "$root",
			userId: "@alice:hs",
			name: "Alice",
		});
		// The room composer of the same room must NOT consume a
		// thread-targeted intent, and vice versa.
		expect(consumeMentionIntentFor("!room:hs", null)).toBeNull();
		expect(consumeMentionIntentFor("!other:hs", "$root")).toBeNull();
		expect(mentionIntent()).not.toBeNull();
		expect(consumeMentionIntentFor("!room:hs", "$root")?.name).toBe("Alice");
	});

	it("consumes-but-drops an intent older than the TTL", () => {
		vi.useFakeTimers();
		requestMention({
			roomId: "!room:hs",
			threadRootId: null,
			userId: "@alice:hs",
			name: "Alice",
		});
		vi.advanceTimersByTime(MENTION_INTENT_TTL_MS + 1);
		// A matching composer mounting much later must not replay it - and
		// the stale intent is gone afterwards, not left to try again.
		expect(consumeMentionIntentFor("!room:hs", null)).toBeNull();
		expect(mentionIntent()).toBeNull();
	});
});
