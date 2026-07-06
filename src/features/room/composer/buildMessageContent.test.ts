import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../timeline/timelineTypes";
import {
	applyMentions,
	buildReplyFallback,
	buildTextMessageContent,
	mentionUserIds,
} from "./buildMessageContent";

function makeEvent(body: string): TimelineEvent {
	// Only the fields buildReplyFallback reads are populated; the rest are
	// irrelevant to the fallback shape and cast away for the test.
	return {
		eventId: "$evt:example.com",
		senderId: "@alice:example.com",
		body,
		formattedBody: null,
	} as unknown as TimelineEvent;
}

const ROOM = "!room:example.com";

describe("buildReplyFallback", () => {
	it("quotes a plain parent body", () => {
		const { bodyPrefix, htmlPrefix } = buildReplyFallback(
			makeEvent("hello world"),
			ROOM,
		);
		expect(bodyPrefix).toBe("> <@alice:example.com> hello world\n\n");
		expect(htmlPrefix).toContain("hello world");
	});

	it("strips the parent's existing reply fallback before quoting (body)", () => {
		// The parent is itself a reply, so its raw body still carries the
		// grandparent's `> <sender>` fallback + blank line. We must quote only
		// the parent's actual reply text, not the nested fallback.
		const parentBody = "> <@bob:example.com> original message\n\nmy reply text";
		const { bodyPrefix } = buildReplyFallback(makeEvent(parentBody), ROOM);
		expect(bodyPrefix).toBe("> <@alice:example.com> my reply text\n\n");
		// The grandparent fallback must not appear anywhere in the new prefix.
		expect(bodyPrefix).not.toContain("@bob:example.com");
		expect(bodyPrefix).not.toContain("original message");
	});

	it("strips the parent's existing reply fallback before quoting (html)", () => {
		const parentBody = "> <@bob:example.com> original message\n\nmy reply text";
		const { htmlPrefix } = buildReplyFallback(makeEvent(parentBody), ROOM);
		expect(htmlPrefix).toContain("my reply text");
		expect(htmlPrefix).not.toContain("@bob:example.com");
		expect(htmlPrefix).not.toContain("original message");
	});

	it("does not grow the fallback across repeated reply hops", () => {
		// Simulate a body already built by a prior hop (its own single fallback)
		// and confirm quoting it again yields exactly one fallback line, not two.
		const firstHopBody = "> <@carol:example.com> grandparent\n\nparent reply";
		const { bodyPrefix } = buildReplyFallback(makeEvent(firstHopBody), ROOM);
		const fallbackLines = bodyPrefix
			.split("\n")
			.filter((l) => l.startsWith("> <"));
		expect(fallbackLines).toHaveLength(1);
	});

	it("falls back to the raw body when stripping empties it", () => {
		// Degenerate parent: a reply whose own text is empty, so its body is
		// nothing but the grandparent fallback. Stripping would leave "", which
		// must not produce a blank `> <sender> ` line with a dangling space.
		const emptyReplyBody = "> <@bob:example.com> original\n\n";
		const { bodyPrefix, htmlPrefix } = buildReplyFallback(
			makeEvent(emptyReplyBody),
			ROOM,
		);
		expect(bodyPrefix).toBe(
			"> <@alice:example.com> > <@bob:example.com> original\n> \n> \n\n",
		);
		expect(htmlPrefix).toContain("original");
	});
});

const ME = "@me:example.com";

describe("mentionUserIds", () => {
	it("is empty with no mentions and no reply", () => {
		expect(mentionUserIds([], null, ME)).toEqual([]);
	});

	it("adds the reply target's author", () => {
		// makeEvent's sender is @alice.
		expect(mentionUserIds([], makeEvent("hi"), ME)).toEqual([
			"@alice:example.com",
		]);
	});

	it("dedupes when the parent's author is already a typed mention", () => {
		const mentions = [{ userId: "@alice:example.com", displayName: "Alice" }];
		expect(mentionUserIds(mentions, makeEvent("hi"), ME)).toEqual([
			"@alice:example.com",
		]);
	});

	it("dedupes repeated typed mentions, preserving first-seen order", () => {
		const mentions = [
			{ userId: "@a:example.com", displayName: "A" },
			{ userId: "@b:example.com", displayName: "B" },
			{ userId: "@a:example.com", displayName: "A" },
		];
		expect(mentionUserIds(mentions, null, ME)).toEqual([
			"@a:example.com",
			"@b:example.com",
		]);
	});

	it("does not mention yourself when replying to your own message", () => {
		expect(mentionUserIds([], makeEvent("hi"), "@alice:example.com")).toEqual(
			[],
		);
	});
});

describe("applyMentions", () => {
	it("sets m.mentions when there are user ids", () => {
		const content: Record<string, unknown> = {};
		applyMentions(content, [], makeEvent("hi"), ME);
		expect(content["m.mentions"]).toEqual({ user_ids: ["@alice:example.com"] });
	});

	it("omits m.mentions entirely when there are none", () => {
		const content: Record<string, unknown> = {};
		applyMentions(content, [], null, ME);
		expect(content).not.toHaveProperty("m.mentions");
	});

	it("clears a pre-existing m.mentions when there are none", () => {
		const content: Record<string, unknown> = {
			"m.mentions": { user_ids: ["@stale:example.com"] },
		};
		applyMentions(content, [], null, ME);
		expect(content).not.toHaveProperty("m.mentions");
	});
});

describe("buildTextMessageContent with a reply", () => {
	it("prepends a single stripped fallback to body and formatted_body", () => {
		const parent = makeEvent("> <@bob:example.com> original\n\nparent reply");
		const content = buildTextMessageContent(
			"new message",
			null,
			[],
			parent,
			ROOM,
			ME,
		);
		expect(content.body).toBe(
			"> <@alice:example.com> parent reply\n\nnew message",
		);
		const formatted = content.formatted_body as string;
		expect(formatted).toContain("new message");
		expect(formatted).not.toContain("@bob:example.com");
		expect(content["m.relates_to"]).toEqual({
			"m.in_reply_to": { event_id: "$evt:example.com" },
		});
	});

	it("adds the parent's author to m.mentions", () => {
		const content = buildTextMessageContent(
			"new message",
			null,
			[],
			makeEvent("parent"),
			ROOM,
			ME,
		);
		expect(content["m.mentions"]).toEqual({
			user_ids: ["@alice:example.com"],
		});
	});

	it("omits m.mentions entirely for a non-reply with no typed mentions", () => {
		const content = buildTextMessageContent("hi", null, [], null, ROOM, ME);
		expect(content["m.mentions"]).toBeUndefined();
	});
});
