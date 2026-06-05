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
			{ currentRoomId: undefined },
		);

		expect(out.leftRoomIds).toEqual(["!a:x", "!b:x"]);
		expect(out.failedNames).toEqual([]);
		expect(out.routeRoomLeft).toBe(false);
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
			{ currentRoomId: undefined },
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
			{
				currentRoomId: undefined,
			},
		);

		expect(out.failedNames).toEqual(["!b:x"]);
	});

	it("reports routeRoomLeft only when the current room's leave succeeded", async () => {
		const client = makeClient({ "!cur:x": "resolve" });
		const out = await leaveChildRooms(
			client,
			[{ roomId: "!cur:x", name: "Current" }],
			{ currentRoomId: "!cur:x" },
		);
		expect(out.routeRoomLeft).toBe(true);
	});

	it("does NOT report routeRoomLeft when the current room's leave failed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const client = makeClient({ "!cur:x": "reject" });
		const out = await leaveChildRooms(
			client,
			[{ roomId: "!cur:x", name: "Current" }],
			{ currentRoomId: "!cur:x" },
		);
		expect(out.routeRoomLeft).toBe(false);
		expect(out.failedNames).toEqual(["Current"]);
	});

	it("invokes onRoomLeft per room as each leave succeeds, skipping failures", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const client = makeClient({
			"!a:x": "resolve",
			"!b:x": "reject",
			"!c:x": "resolve",
		});
		const left: string[] = [];
		const out = await leaveChildRooms(
			client,
			[
				{ roomId: "!a:x", name: "Alpha" },
				{ roomId: "!b:x", name: "Beta" },
				{ roomId: "!c:x", name: "Gamma" },
			],
			{ currentRoomId: undefined, onRoomLeft: (id) => left.push(id) },
		);
		expect(left.sort()).toEqual(["!a:x", "!c:x"]);
		expect(out.leftRoomIds).toEqual(["!a:x", "!c:x"]);
		expect(out.failedNames).toEqual(["Beta"]);
	});

	it("does not mark a leave as failed when onRoomLeft throws", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const client = makeClient({ "!a:x": "resolve" });
		const out = await leaveChildRooms(
			client,
			[{ roomId: "!a:x", name: "Alpha" }],
			{
				currentRoomId: undefined,
				onRoomLeft: () => {
					throw new Error("boom");
				},
			},
		);
		expect(out.leftRoomIds).toEqual(["!a:x"]);
		expect(out.failedNames).toEqual([]);
	});
});

describe("buildPartialLeaveMessage", () => {
	it("uses singular grammar for one left room", () => {
		const msg = buildPartialLeaveMessage(1, ["Beta"]);
		expect(msg).toContain("Left the space and 1 room,");
		expect(msg).toContain("1 room could not be left (Beta)");
	});

	it("uses plural grammar and lists all failed names", () => {
		const msg = buildPartialLeaveMessage(2, ["Beta", "Gamma"]);
		expect(msg).toContain("Left the space and 2 rooms,");
		expect(msg).toContain("2 rooms could not be left (Beta, Gamma)");
	});

	it("omits the left-rooms count when every child leave failed", () => {
		const msg = buildPartialLeaveMessage(0, ["Beta", "Gamma"]);
		// No awkward "Left the space and 0 rooms".
		expect(msg).not.toContain("0 room");
		expect(msg).toContain("Left the space, but 2 rooms could not be left");
		expect(msg).toContain("(Beta, Gamma)");
	});
});
