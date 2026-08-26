import type { MatrixClient, Room } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../test/mockClient";
import { makeSummary } from "../test/summaryFixtures";
import {
	compareSpaceOrder,
	getSpaceOrder,
	moveRootSpace,
	SPACE_ORDER_TYPE,
} from "./spaceOrder";
import type { RoomSummary, SummariesStore } from "./summaries";

function spaceSummary(
	roomId: string,
	overrides: Partial<RoomSummary> = {},
): RoomSummary {
	return makeSummary(roomId, { isSpace: true, ...overrides });
}

function makeCtx(roots: RoomSummary[]) {
	const rooms = new Map(roots.map((r) => [r.roomId, createMockRoom(r.roomId)]));
	const client = createMockClient(rooms);
	const summaries: SummariesStore = Object.fromEntries(
		roots.map((r) => [r.roomId, r]),
	);
	const optimisticallySetSpaceOrder = vi.fn(
		(roomId: string, order: string | null) => {
			const s = summaries[roomId];
			if (s) s.spaceOrder = order;
		},
	);
	return {
		client,
		summaries,
		optimisticallySetSpaceOrder,
		ctx: {
			client: client as unknown as MatrixClient,
			summaries,
			optimisticallySetSpaceOrder,
		},
	};
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
	vi.restoreAllMocks();
});

describe("getSpaceOrder", () => {
	function roomWithOrder(order: unknown): Room {
		const room = createMockRoom("!s:x");
		room.__setRoomAccountData(
			SPACE_ORDER_TYPE,
			order === undefined ? {} : { order },
		);
		return room as unknown as Room;
	}

	it("reads a valid order string", () => {
		expect(getSpaceOrder(roomWithOrder("aaa"))).toBe("aaa");
	});

	it("accepts the empty string (sorts first; Element's validOrder accepts it too)", () => {
		expect(getSpaceOrder(roomWithOrder(""))).toBe("");
	});

	it("treats absent, non-string, over-long, and non-ASCII as unordered", () => {
		expect(getSpaceOrder(createMockRoom("!s:x") as unknown as Room)).toBeNull();
		expect(getSpaceOrder(roomWithOrder(undefined))).toBeNull();
		expect(getSpaceOrder(roomWithOrder(42))).toBeNull();
		expect(getSpaceOrder(roomWithOrder("x".repeat(51)))).toBeNull();
		expect(getSpaceOrder(roomWithOrder("café"))).toBeNull();
	});
});

describe("compareSpaceOrder", () => {
	it("orders by code point, ordered-before-unordered, name tiebreak", () => {
		const a = spaceSummary("!a:x", { name: "Zed", spaceOrder: "a" });
		const b = spaceSummary("!b:x", { name: "Alpha", spaceOrder: "b" });
		const noOrder1 = spaceSummary("!c:x", { name: "Beta" });
		const noOrder2 = spaceSummary("!d:x", { name: "Alpha" });
		expect([b, noOrder1, a, noOrder2].sort(compareSpaceOrder)).toEqual([
			a,
			b,
			noOrder2,
			noOrder1,
		]);
	});

	it("compares order strings by code point, not locale", () => {
		// localeCompare would put "a" before "B"; code points put "B" first.
		const upper = spaceSummary("!u:x", { spaceOrder: "B" });
		const lower = spaceSummary("!l:x", { spaceOrder: "a" });
		expect(compareSpaceOrder(upper, lower)).toBeLessThan(0);
	});

	it("ties on equal order AND equal name break by roomId, locale-independently", () => {
		const a = spaceSummary("!a:x", { name: "Same", spaceOrder: "m" });
		const b = spaceSummary("!b:x", { name: "Same", spaceOrder: "m" });
		expect(compareSpaceOrder(a, b)).toBeLessThan(0);
		expect(compareSpaceOrder(b, a)).toBeGreaterThan(0);
	});
});

describe("moveRootSpace", () => {
	it("writes minimal orders optimistically and via account data", async () => {
		const roots = [
			spaceSummary("!a:x", { spaceOrder: "a" }),
			spaceSummary("!b:x", { spaceOrder: "c" }),
			spaceSummary("!c:x", { spaceOrder: "e" }),
		];
		const { client, ctx, optimisticallySetSpaceOrder } = makeCtx(roots);
		moveRootSpace(ctx, roots, 2, 1);
		// One midpoint write for the moved space only.
		expect(optimisticallySetSpaceOrder).toHaveBeenCalledTimes(1);
		const [roomId, order] = optimisticallySetSpaceOrder.mock.calls[0];
		expect(roomId).toBe("!c:x");
		expect(typeof order).toBe("string");
		expect(client.setRoomAccountData).toHaveBeenCalledWith(
			"!c:x",
			SPACE_ORDER_TYPE,
			{ order },
		);
		await flush();
	});

	it("stamps every unordered space up to the target on first move", () => {
		const roots = [
			spaceSummary("!a:x"),
			spaceSummary("!b:x"),
			spaceSummary("!c:x"),
		];
		const { client, ctx } = makeCtx(roots);
		moveRootSpace(ctx, roots, 2, 0);
		// Moving to the front needs only the moved space ordered.
		expect(client.setRoomAccountData).toHaveBeenCalledTimes(1);
	});

	it("no-ops for a same-index move", () => {
		const roots = [spaceSummary("!a:x"), spaceSummary("!b:x")];
		const { client, ctx } = makeCtx(roots);
		moveRootSpace(ctx, roots, 1, 1);
		expect(client.setRoomAccountData).not.toHaveBeenCalled();
	});

	it("converges a failed write to the SDK's value and toasts once", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const roots = [
			spaceSummary("!a:x"),
			spaceSummary("!b:x"),
			spaceSummary("!c:x"),
		];
		const { client, ctx, summaries } = makeCtx(roots);
		// Both writes fail (moving to the END of an all-unordered list
		// stamps multiple spaces).
		client.setRoomAccountData.mockRejectedValue(new Error("nope"));
		moveRootSpace(ctx, roots, 0, 2);
		expect(client.setRoomAccountData.mock.calls.length).toBeGreaterThan(1);
		await flush();
		// Server holds no orders, so every optimistic order converges back.
		expect(summaries["!a:x"].spaceOrder).toBeNull();
		expect(summaries["!b:x"].spaceOrder).toBeNull();
		expect(summaries["!c:x"].spaceOrder).toBeNull();
		// One batch failure -> one reportError console line, not one per write.
		expect(errorSpy).toHaveBeenCalledTimes(1);
	});

	it("does not revert or toast a failed write superseded by a newer move", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const roots = [
			spaceSummary("!a:x", { spaceOrder: "a" }),
			spaceSummary("!b:x", { spaceOrder: "c" }),
			spaceSummary("!c:x", { spaceOrder: "e" }),
		];
		const { client, ctx, summaries } = makeCtx(roots);
		// First move's write hangs, then fails, AFTER a second move has
		// already re-stamped the same space with a newer optimistic order.
		let rejectFirst: (e: Error) => void = () => {};
		client.setRoomAccountData.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					rejectFirst = reject;
				}),
		);
		moveRootSpace(ctx, roots, 2, 1); // stamps !c:x between a and c
		const firstOrder = summaries["!c:x"].spaceOrder;
		moveRootSpace(
			ctx,
			[...roots].sort(compareSpaceOrder),
			1, // !c:x's new position
			0,
		); // stamps !c:x again, below "a"
		const newerOrder = summaries["!c:x"].spaceOrder;
		expect(newerOrder).not.toBe(firstOrder);

		rejectFirst(new Error("late failure"));
		await flush();

		// The newer optimistic value survives; no misleading failure toast.
		expect(summaries["!c:x"].spaceOrder).toBe(newerOrder);
		expect(errorSpy).not.toHaveBeenCalled();
	});
});
