import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../timeline/timelineTypes";
import {
	applyMentions,
	buildEditContent,
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

	it("attaches an EMPTY m.mentions when there are none (disables legacy body-match push rules)", () => {
		const content: Record<string, unknown> = {};
		applyMentions(content, [], null, ME);
		expect(content["m.mentions"]).toEqual({});
	});

	it("replaces a pre-existing m.mentions with the empty object when there are none", () => {
		const content: Record<string, unknown> = {
			"m.mentions": { user_ids: ["@stale:example.com"] },
		};
		applyMentions(content, [], null, ME);
		expect(content["m.mentions"]).toEqual({});
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

	it("attaches the empty m.mentions for a non-reply with no typed mentions", () => {
		const content = buildTextMessageContent("hi", null, [], null, ROOM, ME);
		expect(content["m.mentions"]).toEqual({});
	});
});

describe("buildTextMessageContent msgtype", () => {
	it("defaults to m.text", () => {
		const content = buildTextMessageContent("hi", null, [], null, ROOM, ME);
		expect(content.msgtype).toBe("m.text");
	});

	it("sends m.emote when asked (the /me path)", () => {
		const content = buildTextMessageContent(
			"waves",
			null,
			[],
			null,
			ROOM,
			ME,
			"m.emote",
		);
		expect(content.msgtype).toBe("m.emote");
		expect(content.body).toBe("waves");
	});
});

describe("buildEditContent msgtype", () => {
	it("keeps an emote an emote through an edit", () => {
		const content = buildEditContent("waves more", null, [], "$t", "m.emote");
		expect(content.msgtype).toBe("m.emote");
		expect((content["m.new_content"] as Record<string, unknown>).msgtype).toBe(
			"m.emote",
		);
	});
});

describe("@room mention (#448)", () => {
	it("applyMentions sets room:true alone when there are no user ids", () => {
		const content: Record<string, unknown> = {};
		applyMentions(content, [], null, ME, true);
		expect(content["m.mentions"]).toEqual({ room: true });
	});

	it("applyMentions carries room:true alongside user ids", () => {
		const content: Record<string, unknown> = {};
		applyMentions(content, [], makeEvent("hi"), ME, true);
		expect(content["m.mentions"]).toEqual({
			user_ids: ["@alice:example.com"],
			room: true,
		});
	});

	it("never emits room:false - the no-mention shape is the bare empty object", () => {
		const content: Record<string, unknown> = {};
		applyMentions(content, [], null, ME, false);
		expect(content["m.mentions"]).toEqual({});
	});

	it("buildTextMessageContent threads the flag through", () => {
		const content = buildTextMessageContent(
			"@room hi",
			null,
			[],
			null,
			ROOM,
			ME,
			"m.text",
			true,
		);
		expect(content["m.mentions"]).toEqual({ room: true });
		// Plain token: no pill, no HTML forced by the mention.
		expect(content.formatted_body).toBeUndefined();
	});

	it("buildEditContent carries the full flag on m.new_content and the NEW one top-level", () => {
		// @room newly added by this edit: both levels carry it (top level
		// is what push rules evaluate, so this is what actually pings).
		const added = buildEditContent(
			"@room updated",
			null,
			[],
			"$target:example.com",
			"m.text",
			true,
		);
		expect(
			(added["m.new_content"] as Record<string, unknown>)["m.mentions"],
		).toEqual({ room: true });
		expect(added["m.mentions"]).toEqual({ room: true });

		// @room kept from the original: new_content keeps it, but the top
		// level must NOT restate it - that would re-ping the room on a typo
		// fix.
		const kept = buildEditContent(
			"@room updated",
			null,
			[],
			"$target:example.com",
			"m.text",
			true,
			{ userIds: [], room: true },
		);
		expect(
			(kept["m.new_content"] as Record<string, unknown>)["m.mentions"],
		).toEqual({ room: true });
		// Top level still attaches the EMPTY object: its presence is what
		// keeps the legacy .m.rule.roomnotif body-match from firing on the
		// "* @room ..." fallback body.
		expect(kept["m.mentions"]).toEqual({});
	});

	it("buildEditContent's top level carries only newly-added user mentions", () => {
		const content = buildEditContent(
			"hi @Old @New",
			null,
			[
				{ userId: "@old:example.com", displayName: "Old" },
				{ userId: "@new:example.com", displayName: "New" },
			],
			"$target:example.com",
			"m.text",
			false,
			{ userIds: ["@old:example.com"], room: false },
		);
		expect(
			(content["m.new_content"] as Record<string, unknown>)["m.mentions"],
		).toEqual({ user_ids: ["@old:example.com", "@new:example.com"] });
		expect(content["m.mentions"]).toEqual({ user_ids: ["@new:example.com"] });
	});
});
