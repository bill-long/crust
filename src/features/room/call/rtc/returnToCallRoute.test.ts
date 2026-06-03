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

	it("falls back to /home/<roomId> when the current space does NOT contain the call room", () => {
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

	it("falls back to /home/<roomId> when there is no current space", () => {
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

	it("never produces /space/X/Y when the current space's children list does not include Y (sub-space descendants)", () => {
		// Subspace nesting: !space contains !subspace which contains !room.
		// The call room is NOT a direct child of !space, so we must NOT
		// emit /space/!space/!room — fall back to /home.
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
		).toBe(`/home/${encodeURIComponent("!room:example.org")}`);
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
