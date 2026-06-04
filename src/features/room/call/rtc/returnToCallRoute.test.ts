import { describe, expect, it } from "vitest";
import type { RoomSummary, SummariesStore } from "../../../../client/summaries";
import { pickReturnToCallRoute } from "./returnToCallRoute";

function makeSummary(overrides: Partial<RoomSummary>): RoomSummary {
	return {
		roomId: "!unused:example.org",
		name: "",
		avatarUrl: null,
		lastMessage: null,
		unreadCount: 0,
		highlightCount: 0,
		membership: "join",
		isEncrypted: false,
		isDirect: false,
		isSpace: false,
		kind: "text",
		callActive: false,
		children: [],
		...overrides,
	};
}

describe("pickReturnToCallRoute", () => {
	it("routes DM rooms to /dm/<roomId> regardless of current space", () => {
		const summaries: SummariesStore = {
			"!dm:example.org": makeSummary({
				roomId: "!dm:example.org",
				isDirect: true,
			}),
			"!space:example.org": makeSummary({
				roomId: "!space:example.org",
				isSpace: true,
				children: ["!dm:example.org"],
			}),
		};
		expect(
			pickReturnToCallRoute(summaries, "!dm:example.org", "!space:example.org"),
		).toBe(`/dm/${encodeURIComponent("!dm:example.org")}`);
	});

	it("uses /space/<spaceId>/<roomId> when the call room is a direct child of the current space", () => {
		const summaries: SummariesStore = {
			"!room:example.org": makeSummary({ roomId: "!room:example.org" }),
			"!space:example.org": makeSummary({
				roomId: "!space:example.org",
				isSpace: true,
				children: ["!room:example.org"],
			}),
		};
		expect(
			pickReturnToCallRoute(
				summaries,
				"!room:example.org",
				"!space:example.org",
			),
		).toBe(
			`/space/${encodeURIComponent("!space:example.org")}/${encodeURIComponent("!room:example.org")}`,
		);
	});

	it("falls back to /home/<roomId> when neither the current space nor any other space contains the call room", () => {
		const summaries: SummariesStore = {
			"!room:example.org": makeSummary({ roomId: "!room:example.org" }),
			"!space:example.org": makeSummary({
				roomId: "!space:example.org",
				isSpace: true,
				children: ["!other:example.org"],
			}),
		};
		expect(
			pickReturnToCallRoute(
				summaries,
				"!room:example.org",
				"!space:example.org",
			),
		).toBe(`/home/${encodeURIComponent("!room:example.org")}`);
	});

	it("falls back to /home/<roomId> when there is no current space and no space contains the call room", () => {
		const summaries: SummariesStore = {
			"!room:example.org": makeSummary({ roomId: "!room:example.org" }),
		};
		expect(
			pickReturnToCallRoute(summaries, "!room:example.org", undefined),
		).toBe(`/home/${encodeURIComponent("!room:example.org")}`);
	});

	it("falls back to /home/<roomId> when the current space is unknown to summaries", () => {
		const summaries: SummariesStore = {
			"!room:example.org": makeSummary({ roomId: "!room:example.org" }),
		};
		expect(
			pickReturnToCallRoute(
				summaries,
				"!room:example.org",
				"!unknown:example.org",
			),
		).toBe(`/home/${encodeURIComponent("!room:example.org")}`);
	});

	it("falls back to /home/<roomId> when the call room is not in summaries (e.g. just kicked)", () => {
		const summaries: SummariesStore = {};
		expect(
			pickReturnToCallRoute(summaries, "!gone:example.org", undefined),
		).toBe(`/home/${encodeURIComponent("!gone:example.org")}`);
	});

	it("falls back to /home/<roomId> when the call room is missing from summaries even if the current space lists it as a child", () => {
		// space.children may include rooms we don't have a joined summary
		// for (unjoined public children, or a just-kicked stale entry).
		// In that case we must NOT route to /space/<spaceId>/<roomId>
		// because the destination pane has no usable state — fall back
		// to /home so the user sees a consistent empty state.
		const summaries: SummariesStore = {
			"!space:example.org": makeSummary({
				roomId: "!space:example.org",
				isSpace: true,
				children: ["!gone:example.org"],
			}),
		};
		expect(
			pickReturnToCallRoute(
				summaries,
				"!gone:example.org",
				"!space:example.org",
			),
		).toBe(`/home/${encodeURIComponent("!gone:example.org")}`);
	});

	it("falls back to a DIFFERENT known space when the current space does NOT contain the call room (preserves the call's space context instead of dropping to /home)", () => {
		// Regression for the Return-click bug: user is viewing space B
		// (which doesn't contain the call room) while a call is active
		// in space A. The old behavior fell back to /home/<callRoom>,
		// which both lost space context AND triggered a route-shape
		// remount that killed the call. New behavior: walk summaries
		// for any space containing the call room and return there.
		const summaries: SummariesStore = {
			"!room:example.org": makeSummary({ roomId: "!room:example.org" }),
			"!callSpace:example.org": makeSummary({
				roomId: "!callSpace:example.org",
				isSpace: true,
				children: ["!room:example.org"],
			}),
			"!otherSpace:example.org": makeSummary({
				roomId: "!otherSpace:example.org",
				isSpace: true,
				children: ["!unrelated:example.org"],
			}),
		};
		expect(
			pickReturnToCallRoute(
				summaries,
				"!room:example.org",
				"!otherSpace:example.org",
			),
		).toBe(
			`/space/${encodeURIComponent("!callSpace:example.org")}/${encodeURIComponent("!room:example.org")}`,
		);
	});

	it("picks deterministically (lexicographically-smallest space id) when multiple spaces contain the call room", () => {
		// A room can be a direct child of several spaces. The Matrix
		// `m.space.parent` canonical-parent metadata isn't surfaced via
		// summaries today, so we pick deterministically by sorted id so
		// behavior is stable across reloads.
		const summaries: SummariesStore = {
			"!room:example.org": makeSummary({ roomId: "!room:example.org" }),
			"!zSpace:example.org": makeSummary({
				roomId: "!zSpace:example.org",
				isSpace: true,
				children: ["!room:example.org"],
			}),
			"!aSpace:example.org": makeSummary({
				roomId: "!aSpace:example.org",
				isSpace: true,
				children: ["!room:example.org"],
			}),
			"!mSpace:example.org": makeSummary({
				roomId: "!mSpace:example.org",
				isSpace: true,
				children: ["!room:example.org"],
			}),
		};
		expect(
			pickReturnToCallRoute(summaries, "!room:example.org", undefined),
		).toBe(
			`/space/${encodeURIComponent("!aSpace:example.org")}/${encodeURIComponent("!room:example.org")}`,
		);
	});

	it("prefers the current space over other candidate spaces when the current space qualifies", () => {
		// If the user is already in a space that contains the call room,
		// preserve that context even when other spaces also qualify —
		// don't re-flip them into a different (lexicographically-smaller)
		// space they were not viewing.
		const summaries: SummariesStore = {
			"!room:example.org": makeSummary({ roomId: "!room:example.org" }),
			"!zCurrent:example.org": makeSummary({
				roomId: "!zCurrent:example.org",
				isSpace: true,
				children: ["!room:example.org"],
			}),
			"!aOther:example.org": makeSummary({
				roomId: "!aOther:example.org",
				isSpace: true,
				children: ["!room:example.org"],
			}),
		};
		expect(
			pickReturnToCallRoute(
				summaries,
				"!room:example.org",
				"!zCurrent:example.org",
			),
		).toBe(
			`/space/${encodeURIComponent("!zCurrent:example.org")}/${encodeURIComponent("!room:example.org")}`,
		);
	});

	it("falls back to a parent subspace when the call room is in a subspace (NOT the top-level space)", () => {
		// Subspace nesting: !space contains !subspace which contains !room.
		// The call room is a direct child of !subspace, NOT of !space.
		// The helper should return /space/!subspace/!room — the room's
		// nearest known parent space — rather than falling back to /home.
		const summaries: SummariesStore = {
			"!room:example.org": makeSummary({ roomId: "!room:example.org" }),
			"!subspace:example.org": makeSummary({
				roomId: "!subspace:example.org",
				isSpace: true,
				children: ["!room:example.org"],
			}),
			"!space:example.org": makeSummary({
				roomId: "!space:example.org",
				isSpace: true,
				children: ["!subspace:example.org"],
			}),
		};
		expect(
			pickReturnToCallRoute(
				summaries,
				"!room:example.org",
				"!space:example.org",
			),
		).toBe(
			`/space/${encodeURIComponent("!subspace:example.org")}/${encodeURIComponent("!room:example.org")}`,
		);
	});

	it("ignores currentSpaceId if it points at a non-space summary", () => {
		const summaries: SummariesStore = {
			"!room:example.org": makeSummary({ roomId: "!room:example.org" }),
			"!alsoroom:example.org": makeSummary({
				roomId: "!alsoroom:example.org",
				isSpace: false,
				children: ["!room:example.org"],
			}),
		};
		expect(
			pickReturnToCallRoute(
				summaries,
				"!room:example.org",
				"!alsoroom:example.org",
			),
		).toBe(`/home/${encodeURIComponent("!room:example.org")}`);
	});

	it("URL-encodes both space id and room id", () => {
		const summaries: SummariesStore = {
			"!room:example.org": makeSummary({ roomId: "!room:example.org" }),
			"!space:example.org": makeSummary({
				roomId: "!space:example.org",
				isSpace: true,
				children: ["!room:example.org"],
			}),
		};
		const url = pickReturnToCallRoute(
			summaries,
			"!room:example.org",
			"!space:example.org",
		);
		// `:` must be percent-encoded in both segments.
		expect(url).not.toContain("!room:example.org");
		expect(url).not.toContain("!space:example.org");
		expect(url).toContain(encodeURIComponent("!room:example.org"));
		expect(url).toContain(encodeURIComponent("!space:example.org"));
	});
});
