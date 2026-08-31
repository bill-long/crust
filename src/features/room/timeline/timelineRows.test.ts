import { describe, expect, it } from "vitest";
import { makeTimelineEvent } from "../../../test/timelineEvent";
import {
	dateSeparatorMode,
	rowShowsOwnDate,
	shouldShowHeader,
} from "./timelineRows";
import type { TimelineEvent } from "./timelineTypes";

const at = (y: number, m: number, d: number, h = 12, min = 0): number =>
	new Date(y, m, d, h, min).getTime();

const MON = at(2026, 4, 25, 10, 0);
const TUE = at(2026, 4, 26, 10, 0);

const msg = (ts: number, overrides: Partial<TimelineEvent> = {}) =>
	makeTimelineEvent({
		eventId: `$${ts}-${overrides.msgtype ?? "text"}`,
		senderId: "@alice:example.com",
		timestamp: ts,
		...overrides,
	});

const notice = (ts: number) =>
	msg(ts, { stateNotice: { text: "alice joined the room", icon: "info" } });

const emote = (ts: number) => msg(ts, { msgtype: "m.emote", body: "waves" });

/**
 * A member of a collapsed membership run. Carries both fields a real run
 * member has - `eventProjection.test.ts` locks the rule that a
 * `membershipTransition` never arrives without its `stateNotice`, which is
 * what lets `rowShowsOwnDate` treat these rows as undated via the
 * state-notice branch alone.
 */
const runMember = (ts: number) =>
	msg(ts, {
		stateNotice: { text: "alice joined the room", icon: "join" },
		membershipTransition: {
			kind: "join",
			userId: "@alice:example.com",
			subject: "alice",
			avatarUrl: null,
		},
	});

/** dateSeparatorMode with the render-time flags defaulted to false. */
const modeAt = (
	events: readonly TimelineEvent[],
	index: number,
	opts: { ignored?: boolean } = {},
) => dateSeparatorMode(events, index, null, opts.ignored ?? false);

describe("dateSeparatorMode", () => {
	it("draws nothing between two messages on the same day", () => {
		const events = [msg(MON), msg(MON + 60_000)];
		expect(modeAt(events, 1)).toBe("none");
	});

	it("draws a bare rule when the new day opens with an ordinary message", () => {
		// The message renders a header, and the header carries the date.
		const events = [msg(MON), msg(TUE)];
		expect(modeAt(events, 1)).toBe("rule");
		expect(shouldShowHeader(events, 1, null)).toBe(true);
	});

	it("labels the boundary when the new day opens with a state notice", () => {
		const events = [msg(MON), notice(TUE)];
		expect(modeAt(events, 1)).toBe("labeled");
	});

	it("labels the boundary when the new day opens with an emote", () => {
		const events = [msg(MON), emote(TUE)];
		expect(modeAt(events, 1)).toBe("labeled");
	});

	it("labels the boundary when the new day opens with a collapsed membership run", () => {
		// Collapsed runs need no flag of their own: a run member always has
		// `membershipTransition` set, which implies `stateNotice` is set, so
		// the row is already undated by the state-notice rule.
		const events = [msg(MON), runMember(TUE)];
		expect(modeAt(events, 1)).toBe("labeled");
		expect(shouldShowHeader(events, 1, null)).toBe(false);
	});

	it("labels the boundary when the new day opens with a blocked sender", () => {
		const events = [msg(MON), msg(TUE)];
		expect(modeAt(events, 1, { ignored: true })).toBe("labeled");
	});

	it("draws nothing at index 0 when the first row dates itself", () => {
		// Index 0 is the top of loaded scrollback, not a day boundary; a
		// bare rule there would separate the loader from the first message
		// while conveying nothing.
		expect(modeAt([msg(MON)], 0)).toBe("none");
	});

	it("labels index 0 when the first row cannot date itself", () => {
		expect(modeAt([notice(MON)], 0)).toBe("labeled");
		expect(modeAt([emote(MON)], 0)).toBe("labeled");
	});

	it("draws nothing for an out-of-range index", () => {
		expect(modeAt([msg(MON)], 5)).toBe("none");
	});
});

describe("day-boundary date visibility invariant", () => {
	// A day boundary must always make its date visible somewhere: either
	// the separator is labeled, or the row below states its own date.
	// Exhaustive over every row kind that can open a day.
	const kinds: Array<{
		name: string;
		event: TimelineEvent;
		ignored?: boolean;
	}> = [
		{ name: "ordinary message", event: msg(TUE) },
		{ name: "state notice", event: notice(TUE) },
		{ name: "emote", event: emote(TUE) },
		{ name: "collapsed membership run", event: runMember(TUE) },
		{ name: "blocked sender", event: msg(TUE), ignored: true },
		{ name: "blocked sender emote", event: emote(TUE), ignored: true },
	];

	for (const kind of kinds) {
		it(`shows the date at a boundary opening with a ${kind.name}`, () => {
			const events = [msg(MON), kind.event];
			const ignored = kind.ignored ?? false;
			const mode = modeAt(events, 1, { ignored });
			expect(mode).not.toBe("none");
			// The whole point: never a bare rule over a row that cannot
			// state its own date.
			const dated = rowShowsOwnDate(events, 1, null, ignored);
			expect(mode === "labeled" || dated).toBe(true);
		});
	}
});
