import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildPartialLeaveMessage,
	leaveChildRooms,
} from "./leaveSpaceChildren";

function makeClient(
	behavior: Record<string, "resolve" | "reject">,
): Pick<MatrixClient, "leave"> {
	return {
		leave: vi.fn((roomId: string) =>
			behavior[roomId] === "reject"
				? Promise.reject(new Error(`cannot leave ${roomId}`))
				: Promise.resolve({}),
		),
	} as unknown as Pick<MatrixClient, "leave">;
}

describe("leaveChildRooms", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("leaves all children and reports them as left", async () => {
		const client = makeClient({ "!a:x": "resolve", "!b:x": "resolve" });
		const out = await leaveChildRooms(
			client,
			[
				{ roomId: "!a:x", name: "Alpha" },
				{ roomId: "!b:x", name: "Beta" },
			],
			{ currentRoomId: undefined, activeCallRoomId: null },
		);

		expect(out.leftRoomIds).toEqual(["!a:x", "!b:x"]);
		expect(out.failedNames).toEqual([]);
		expect(out.routeRoomLeft).toBe(false);
		expect(out.callRoomLeft).toBe(false);
		expect(client.leave).toHaveBeenCalledTimes(2);
	});

	it("collects names of failed leaves without aborting the batch", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const client = makeClient({ "!a:x": "resolve", "!b:x": "reject" });
		const out = await leaveChildRooms(
			client,
			[
				{ roomId: "!a:x", name: "Alpha" },
				{ roomId: "!b:x", name: "Beta" },
			],
			{ currentRoomId: undefined, activeCallRoomId: null },
		);

		expect(out.leftRoomIds).toEqual(["!a:x"]);
		expect(out.failedNames).toEqual(["Beta"]);
	});

	it("falls back to the room ID when a failed child has a blank name", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const client = makeClient({ "!b:x": "reject" });
		const out = await leaveChildRooms(
			client,
			[{ roomId: "!b:x", name: "   " }],
			{ currentRoomId: undefined, activeCallRoomId: null },
		);

		expect(out.failedNames).toEqual(["!b:x"]);
	});

	it("reports routeRoomLeft only when the current room's leave succeeded", async () => {
		const client = makeClient({ "!cur:x": "resolve" });
		const out = await leaveChildRooms(
			client,
			[{ roomId: "!cur:x", name: "Current" }],
			{ currentRoomId: "!cur:x", activeCallRoomId: null },
		);
		expect(out.routeRoomLeft).toBe(true);
	});

	it("does NOT report routeRoomLeft when the current room's leave failed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const client = makeClient({ "!cur:x": "reject" });
		const out = await leaveChildRooms(
			client,
			[{ roomId: "!cur:x", name: "Current" }],
			{ currentRoomId: "!cur:x", activeCallRoomId: null },
		);
		expect(out.routeRoomLeft).toBe(false);
		expect(out.failedNames).toEqual(["Current"]);
	});

	it("reports callRoomLeft only when the call room's leave succeeded", async () => {
		const client = makeClient({ "!call:x": "resolve" });
		const out = await leaveChildRooms(
			client,
			[{ roomId: "!call:x", name: "Voice" }],
			{ currentRoomId: undefined, activeCallRoomId: "!call:x" },
		);
		expect(out.callRoomLeft).toBe(true);
	});

	it("does NOT report callRoomLeft when the call room's leave failed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const client = makeClient({ "!call:x": "reject" });
		const out = await leaveChildRooms(
			client,
			[{ roomId: "!call:x", name: "Voice" }],
			{ currentRoomId: undefined, activeCallRoomId: "!call:x" },
		);
		expect(out.callRoomLeft).toBe(false);
	});
});

describe("buildPartialLeaveMessage", () => {
	it("uses singular grammar for one left room", () => {
		const msg = buildPartialLeaveMessage(1, ["Beta"]);
		expect(msg).toContain("Left the space and 1 room,");
		expect(msg).toContain("1 could not be left (Beta)");
	});

	it("uses plural grammar and lists all failed names", () => {
		const msg = buildPartialLeaveMessage(2, ["Beta", "Gamma"]);
		expect(msg).toContain("Left the space and 2 rooms,");
		expect(msg).toContain("2 could not be left (Beta, Gamma)");
	});
});
