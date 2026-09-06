import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import {
	createMatrixEvent,
	createMockClient,
	createMockRoom,
	type MockEvent,
} from "../../../test/mockClient";
import { eventToTimelineEvent } from "./eventProjection";

const project = (evt: MockEvent) => {
	const room = createMockRoom("!r:x", [], [{ userId: "@a:x", name: "A" }]);
	const client = createMockClient() as unknown as MatrixClient;
	return eventToTimelineEvent(
		createMatrixEvent(evt) as unknown as MatrixEvent,
		room as unknown as Room,
		client,
	);
};

const memberEvent = (
	content: Record<string, unknown>,
	prevContent?: Record<string, unknown>,
): MockEvent => ({
	eventId: "$m",
	roomId: "!r:x",
	sender: "@a:x",
	type: "m.room.member",
	ts: 1000,
	stateKey: "@a:x",
	content,
	...(prevContent !== undefined ? { prevContent } : {}),
});

describe("membershipTransition implies stateNotice", () => {
	// `rowShowsOwnDate` (timelineRows.ts) leans on this implication: a row
	// inside a collapsed membership run is undated because `shouldShowHeader`
	// has already rejected it as a *state notice*, so the run needs no check
	// of its own. If a transition could ever arrive without a notice, a day
	// boundary would draw a bare rule over a row that shows no date anywhere.
	// The implication is enforced by a single `stateNotice !== null &&` in
	// `eventToTimelineEvent`; this is what locks it.

	it("sets both for a real join", () => {
		const projected = project(memberEvent({ membership: "join" }));
		expect(projected.stateNotice).not.toBeNull();
		expect(projected.membershipTransition).not.toBeNull();
	});

	it("sets neither for a member event that produces no notice", () => {
		// A join->join repeat with no profile change is the reachable case:
		// member-typed, so it reaches the transition branch, but it renders
		// no notice. Without the guard it would carry a transition alone.
		const projected = project(
			memberEvent(
				{ membership: "join", displayname: "A" },
				{ membership: "join", displayname: "A" },
			),
		);
		expect(projected.stateNotice).toBeNull();
		expect(projected.membershipTransition).toBeNull();
	});

	it("can set a notice without a transition (the other direction is fine)", () => {
		// A display-name change renders a notice but is not a transition the
		// timeline collapses. Only transition-without-notice breaks the
		// invariant above.
		const projected = project(
			memberEvent(
				{ membership: "join", displayname: "B" },
				{ membership: "join", displayname: "A" },
			),
		);
		expect(projected.stateNotice).not.toBeNull();
		expect(projected.membershipTransition).toBeNull();
	});
});
