import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../timeline/timelineTypes";
import {
	buildReplyFallback,
	buildTextMessageContent,
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

describe("buildTextMessageContent with a reply", () => {
	it("prepends a single stripped fallback to body and formatted_body", () => {
		const parent = makeEvent("> <@bob:example.com> original\n\nparent reply");
		const content = buildTextMessageContent(
			"new message",
			null,
			[],
			parent,
			ROOM,
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
});
