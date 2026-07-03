import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkRoomToSpace, unlinkRoomFromSpace } from "./spaceChildLink";

interface MockOpts {
	childBehavior?: "resolve" | "reject";
	parentBehavior?: "resolve" | "reject";
	domain?: string | null;
	userId?: string | null;
	/** maySendStateEvent result for the child room (undefined = no room). */
	maySendParent?: boolean;
}

function makeClient(opts: MockOpts = {}) {
	const sendStateEvent = vi.fn((roomId: string, type: string) => {
		const isChild = type === "m.space.child";
		const behavior = isChild
			? (opts.childBehavior ?? "resolve")
			: (opts.parentBehavior ?? "resolve");
		return behavior === "reject"
			? Promise.reject(new Error(`${type} on ${roomId} failed`))
			: Promise.resolve({ event_id: "$x" });
	});
	const room =
		opts.maySendParent === undefined
			? null
			: {
					currentState: {
						maySendStateEvent: () => opts.maySendParent === true,
					},
				};
	const client = {
		sendStateEvent,
		getDomain: () => (opts.domain === undefined ? "example.com" : opts.domain),
		getUserId: () =>
			opts.userId === undefined ? "@me:example.com" : opts.userId,
		getRoom: () => room,
	} as unknown as MockClient;
	return { client, sendStateEvent };
}

type MockClient = Pick<
	MatrixClient,
	"sendStateEvent" | "getDomain" | "getUserId" | "getRoom"
>;

describe("linkRoomToSpace", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends m.space.child on the parent and m.space.parent on the child", async () => {
		const { client, sendStateEvent } = makeClient();
		const res = await linkRoomToSpace(client, "!space:x", "!child:x");

		expect(res).toEqual({ childOk: true, parent: "ok" });
		expect(sendStateEvent).toHaveBeenCalledWith(
			"!space:x",
			"m.space.child",
			{ via: ["example.com"], suggested: false },
			"!child:x",
		);
		expect(sendStateEvent).toHaveBeenCalledWith(
			"!child:x",
			"m.space.parent",
			{ via: ["example.com"], canonical: true },
			"!space:x",
		);
	});

	it("does NOT send m.space.parent when the child send fails (no orphan)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { client, sendStateEvent } = makeClient({ childBehavior: "reject" });
		const res = await linkRoomToSpace(client, "!space:x", "!child:x");

		expect(res.childOk).toBe(false);
		expect(res.childError).toBeInstanceOf(Error);
		expect(res.parent).toBe("skipped");
		// Sequential: only the child send was attempted — no orphaned parent.
		expect(sendStateEvent).toHaveBeenCalledTimes(1);
		expect(sendStateEvent).not.toHaveBeenCalledWith(
			"!child:x",
			"m.space.parent",
			expect.anything(),
			"!space:x",
		);
	});

	it("treats a failed parent send as non-fatal (childOk stays true)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { client } = makeClient({ parentBehavior: "reject" });
		const res = await linkRoomToSpace(client, "!space:x", "!child:x");
		expect(res.childOk).toBe(true);
		expect(res.parent).toBe("failed");
		expect(res.parentError).toBeInstanceOf(Error);
	});

	it("skips the parent send when checkParentPermission is set and the user can't", async () => {
		const { client, sendStateEvent } = makeClient({ maySendParent: false });
		const res = await linkRoomToSpace(client, "!space:x", "!child:x", {
			checkParentPermission: true,
		});
		expect(res.parent).toBe("skipped");
		expect(res.childOk).toBe(true);
		expect(sendStateEvent).toHaveBeenCalledTimes(1);
		expect(sendStateEvent).toHaveBeenCalledWith(
			"!space:x",
			"m.space.child",
			{ via: ["example.com"], suggested: false },
			"!child:x",
		);
	});

	it("sends the parent when checkParentPermission is set and the user can", async () => {
		const { client, sendStateEvent } = makeClient({ maySendParent: true });
		const res = await linkRoomToSpace(client, "!space:x", "!child:x", {
			checkParentPermission: true,
		});
		expect(res.parent).toBe("ok");
		expect(sendStateEvent).toHaveBeenCalledTimes(2);
	});

	it("skips the parent when checkParentPermission is set and the child room is unknown", async () => {
		// getRoom returns null (room not in SDK) → cannot verify permission.
		const { client, sendStateEvent } = makeClient({ maySendParent: undefined });
		const res = await linkRoomToSpace(client, "!space:x", "!child:x", {
			checkParentPermission: true,
		});
		expect(res.parent).toBe("skipped");
		expect(sendStateEvent).toHaveBeenCalledTimes(1);
	});

	it("sends an empty via array when the domain is null", async () => {
		const { client, sendStateEvent } = makeClient({ domain: null });
		await linkRoomToSpace(client, "!space:x", "!child:x");
		expect(sendStateEvent).toHaveBeenCalledWith(
			"!space:x",
			"m.space.child",
			{ via: [], suggested: false },
			"!child:x",
		);
	});

	it("treats a throwing permission probe as 'cannot send parent'", async () => {
		const client = {
			sendStateEvent: vi.fn().mockResolvedValue({ event_id: "$x" }),
			getDomain: () => "example.com",
			getUserId: () => "@me:example.com",
			getRoom: () => ({
				currentState: {
					maySendStateEvent: () => {
						throw new Error("boom");
					},
				},
			}),
		} as unknown as MockClient;
		const res = await linkRoomToSpace(client, "!space:x", "!child:x", {
			checkParentPermission: true,
		});
		expect(res.parent).toBe("skipped");
		expect(res.childOk).toBe(true);
		expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
	});
});

describe("unlinkRoomFromSpace", () => {
	afterEach(() => vi.restoreAllMocks());

	it("clears both m.space.child and m.space.parent", async () => {
		const { client, sendStateEvent } = makeClient({ maySendParent: true });
		const res = await unlinkRoomFromSpace(client, "!space:x", "!child:x", {
			checkParentPermission: true,
		});
		expect(res).toEqual({ childOk: true, parent: "ok" });
		expect(sendStateEvent).toHaveBeenCalledWith(
			"!space:x",
			"m.space.child",
			{},
			"!child:x",
		);
		expect(sendStateEvent).toHaveBeenCalledWith(
			"!child:x",
			"m.space.parent",
			{},
			"!space:x",
		);
	});

	it("skips the m.space.parent removal without permission", async () => {
		const { client, sendStateEvent } = makeClient({ maySendParent: false });
		const res = await unlinkRoomFromSpace(client, "!space:x", "!child:x", {
			checkParentPermission: true,
		});
		expect(res.parent).toBe("skipped");
		expect(sendStateEvent).toHaveBeenCalledTimes(1);
	});

	it("does not clear m.space.parent when the m.space.child removal fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { client, sendStateEvent } = makeClient({
			childBehavior: "reject",
			maySendParent: true,
		});
		const res = await unlinkRoomFromSpace(client, "!space:x", "!child:x", {
			checkParentPermission: true,
		});
		expect(res.childOk).toBe(false);
		expect(res.parent).toBe("skipped");
		expect(sendStateEvent).toHaveBeenCalledTimes(1);
	});
});
