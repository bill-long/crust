import type { MatrixClient, Room } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { canSendStateEvent, readMyMembership } from "./stateEventPermission";
import type { SummariesStore } from "./summaries";

function makeClient(sdkMembership: string, maySend = true) {
	const room = {
		getMyMembership: () => sdkMembership,
		currentState: {
			maySendStateEvent: () => maySend,
		},
	} as unknown as Room;
	return {
		getRoom: () => room,
		getUserId: () => "@me:example.com",
	} as unknown as Pick<MatrixClient, "getRoom" | "getUserId">;
}

function summariesMembership(membership: string): SummariesStore {
	return {
		"!room:example.com": { membership },
	} as unknown as SummariesStore;
}

describe("state-event permission", () => {
	it("trusts an optimistic leave over the SDK's stale joined membership", () => {
		const client = makeClient("join");

		expect(
			canSendStateEvent(
				client,
				"!room:example.com",
				"m.room.name",
				summariesMembership("leave"),
			),
		).toBe(false);
	});

	it("trusts an optimistic join over the SDK's stale left membership", () => {
		const client = makeClient("leave");

		expect(
			canSendStateEvent(
				client,
				"!room:example.com",
				"m.room.name",
				summariesMembership("join"),
			),
		).toBe(true);
	});

	it("falls back to SDK membership when the summaries store has no room", () => {
		expect(readMyMembership(makeClient("join"), "!room:example.com")).toBe(
			"join",
		);
		expect(
			canSendStateEvent(
				makeClient("leave"),
				"!room:example.com",
				"m.room.name",
			),
		).toBe(false);
	});

	it("still requires the event's power-level permission", () => {
		expect(
			canSendStateEvent(
				makeClient("join", false),
				"!room:example.com",
				"m.room.name",
			),
		).toBe(false);
	});
});
