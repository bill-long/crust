import type { MatrixClient, Room } from "matrix-js-sdk";
import { createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../test/mockClient";
import {
	_resetMarkedUnreadConsumerForTests,
	canMarkRoomUnread,
	clearRoomMarkedUnread,
	getRoomMarkedUnread,
	MARKED_UNREAD_TYPE,
	MARKED_UNREAD_TYPE_UNSTABLE,
	markRoomUnread,
	useMarkedUnreadConsumer,
} from "./markedUnread";
import type { RoomSummary, SummariesStore } from "./summaries";

function summary(
	roomId: string,
	overrides: Partial<RoomSummary> = {},
): RoomSummary {
	return {
		roomId,
		name: roomId,
		avatarUrl: null,
		lastMessage: null,
		unreadCount: 0,
		highlightCount: 0,
		markedUnread: false,
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

function makeCtx(opts: { markedUnread: boolean }) {
	const room = createMockRoom("!r:x");
	const client = createMockClient(new Map([[room.roomId, room]]));
	const summaries: SummariesStore = {
		"!r:x": summary("!r:x", { markedUnread: opts.markedUnread }),
	};
	// Mirror the real store function: mutate the summary so the actions'
	// own gates see the optimistic state, and record calls for asserting.
	const optimisticallySetMarkedUnread = vi.fn(
		(roomId: string, value: boolean) => {
			if (summaries[roomId]) summaries[roomId].markedUnread = value;
		},
	);
	return {
		room,
		client,
		summaries,
		ctx: {
			client: client as unknown as MatrixClient,
			summaries,
			optimisticallySetMarkedUnread,
		},
		optimisticallySetMarkedUnread,
	};
}

/** Flush the microtask queue so .then/.catch chains of settled promises run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
	vi.restoreAllMocks();
});

describe("getRoomMarkedUnread", () => {
	it("returns false when no account data exists", () => {
		const room = createMockRoom("!r:x");
		expect(getRoomMarkedUnread(room as unknown as Room)).toBe(false);
	});

	it("reads the stable type", () => {
		const room = createMockRoom("!r:x");
		room.__setRoomAccountData(MARKED_UNREAD_TYPE, { unread: true });
		expect(getRoomMarkedUnread(room as unknown as Room)).toBe(true);
	});

	it("falls back to the unstable type when the stable one is absent", () => {
		const room = createMockRoom("!r:x");
		room.__setRoomAccountData(MARKED_UNREAD_TYPE_UNSTABLE, { unread: true });
		expect(getRoomMarkedUnread(room as unknown as Room)).toBe(true);
	});

	it("lets a stable false override an unstable true", () => {
		const room = createMockRoom("!r:x");
		room.__setRoomAccountData(MARKED_UNREAD_TYPE, { unread: false });
		room.__setRoomAccountData(MARKED_UNREAD_TYPE_UNSTABLE, { unread: true });
		expect(getRoomMarkedUnread(room as unknown as Room)).toBe(false);
	});

	it("treats malformed content as false", () => {
		const room = createMockRoom("!r:x");
		room.__setRoomAccountData(MARKED_UNREAD_TYPE, { unread: "yes" });
		expect(getRoomMarkedUnread(room as unknown as Room)).toBe(false);
	});
});

describe("canMarkRoomUnread", () => {
	it("is false without a summary", () => {
		expect(canMarkRoomUnread(undefined)).toBe(false);
	});

	it("is true for a read, unmarked room", () => {
		expect(canMarkRoomUnread(summary("!r:x"))).toBe(true);
	});

	it("is false once an indicator is showing (count or flag)", () => {
		expect(canMarkRoomUnread(summary("!r:x", { unreadCount: 2 }))).toBe(false);
		expect(canMarkRoomUnread(summary("!r:x", { markedUnread: true }))).toBe(
			false,
		);
	});

	it("ignores a muted room's hidden count but not its flag", () => {
		expect(
			canMarkRoomUnread(summary("!r:x", { unreadCount: 2 }), { muted: true }),
		).toBe(true);
		expect(
			canMarkRoomUnread(summary("!r:x", { markedUnread: true }), {
				muted: true,
			}),
		).toBe(false);
	});
});

describe("markRoomUnread", () => {
	it("optimistically flips the flag and writes stable account data", () => {
		const { client, ctx, optimisticallySetMarkedUnread } = makeCtx({
			markedUnread: false,
		});
		markRoomUnread(ctx, "!r:x");
		expect(optimisticallySetMarkedUnread).toHaveBeenCalledWith("!r:x", true);
		expect(client.setRoomAccountData).toHaveBeenCalledWith(
			"!r:x",
			MARKED_UNREAD_TYPE,
			{ unread: true },
		);
	});

	it("no-ops when the room is already marked", () => {
		const { client, ctx, optimisticallySetMarkedUnread } = makeCtx({
			markedUnread: true,
		});
		markRoomUnread(ctx, "!r:x");
		expect(optimisticallySetMarkedUnread).not.toHaveBeenCalled();
		expect(client.setRoomAccountData).not.toHaveBeenCalled();
	});

	it("rolls back the optimistic flag when the write fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { client, ctx, optimisticallySetMarkedUnread } = makeCtx({
			markedUnread: false,
		});
		client.setRoomAccountData.mockRejectedValueOnce(new Error("nope"));
		markRoomUnread(ctx, "!r:x");
		await flush();
		expect(optimisticallySetMarkedUnread).toHaveBeenLastCalledWith(
			"!r:x",
			false,
		);
	});
});

describe("clearRoomMarkedUnread", () => {
	it("no-ops (no write at all) when the room is not marked", () => {
		const { client, ctx, optimisticallySetMarkedUnread } = makeCtx({
			markedUnread: false,
		});
		clearRoomMarkedUnread(ctx, "!r:x");
		expect(optimisticallySetMarkedUnread).not.toHaveBeenCalled();
		expect(client.setRoomAccountData).not.toHaveBeenCalled();
	});

	it("optimistically clears and writes unread:false when marked", () => {
		const { client, ctx, optimisticallySetMarkedUnread } = makeCtx({
			markedUnread: true,
		});
		clearRoomMarkedUnread(ctx, "!r:x");
		expect(optimisticallySetMarkedUnread).toHaveBeenCalledWith("!r:x", false);
		expect(client.setRoomAccountData).toHaveBeenCalledWith(
			"!r:x",
			MARKED_UNREAD_TYPE,
			{ unread: false },
		);
	});

	it("rolls the flag back on when the write fails (server still has it marked)", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const { client, ctx, summaries, optimisticallySetMarkedUnread } = makeCtx({
			markedUnread: true,
		});
		client.setRoomAccountData.mockRejectedValueOnce(new Error("nope"));
		clearRoomMarkedUnread(ctx, "!r:x");
		await flush();
		expect(optimisticallySetMarkedUnread).toHaveBeenLastCalledWith(
			"!r:x",
			true,
		);
		expect(consoleError).toHaveBeenCalled();
		// The restored flag means the next open retries the write.
		client.setRoomAccountData.mockClear();
		clearRoomMarkedUnread(ctx, "!r:x");
		expect(client.setRoomAccountData).toHaveBeenCalledTimes(1);
		expect(summaries["!r:x"].markedUnread).toBe(false);
	});
});

describe("marked-unread write serialization", () => {
	it("queues an opposite-value write behind an in-flight one for the same room", async () => {
		const { client, ctx } = makeCtx({ markedUnread: false });
		let resolveFirst: (v: unknown) => void = () => {};
		client.setRoomAccountData.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolveFirst = r;
				}),
		);

		markRoomUnread(ctx, "!r:x"); // PUT unread:true, held in flight
		clearRoomMarkedUnread(ctx, "!r:x"); // must NOT race the first PUT
		await flush();
		expect(client.setRoomAccountData).toHaveBeenCalledTimes(1);

		resolveFirst({});
		await flush();
		expect(client.setRoomAccountData).toHaveBeenCalledTimes(2);
		expect(client.setRoomAccountData).toHaveBeenLastCalledWith(
			"!r:x",
			MARKED_UNREAD_TYPE,
			{ unread: false },
		);
	});

	it("a failed write does not block the next queued write", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { client, ctx } = makeCtx({ markedUnread: false });
		client.setRoomAccountData.mockRejectedValueOnce(new Error("boom"));
		markRoomUnread(ctx, "!r:x");
		await flush();
		// Rollback ran; mark again - the new write must go through.
		markRoomUnread(ctx, "!r:x");
		await flush();
		expect(client.setRoomAccountData).toHaveBeenCalledTimes(2);
	});
});

describe("useMarkedUnreadConsumer", () => {
	beforeEach(() => {
		_resetMarkedUnreadConsumerForTests();
	});

	function makeConsumerHarness(opts: { markedUnread: boolean }) {
		const base = makeCtx(opts);
		const [roomId, setRoomId] = createSignal<string | undefined>(undefined);
		const dispose = createRoot((d) => {
			useMarkedUnreadConsumer(base.ctx, roomId);
			return d;
		});
		return { ...base, setRoomId, dispose };
	}

	it("clears the flag when a marked room is opened", () => {
		const { client, summaries, setRoomId, dispose } = makeConsumerHarness({
			markedUnread: true,
		});
		setRoomId("!r:x");
		expect(summaries["!r:x"].markedUnread).toBe(false);
		expect(client.setRoomAccountData).toHaveBeenCalledWith(
			"!r:x",
			MARKED_UNREAD_TYPE,
			{ unread: false },
		);
		dispose();
	});

	it("does not consume a flag set while the room is already open", () => {
		const harness = makeConsumerHarness({ markedUnread: false });
		harness.setRoomId("!r:x");
		// User marks the OPEN room (overflow action / right-click on its row).
		markRoomUnread(harness.ctx, "!r:x");
		expect(harness.summaries["!r:x"].markedUnread).toBe(true);
		expect(harness.client.setRoomAccountData).toHaveBeenCalledTimes(1);
		expect(harness.client.setRoomAccountData).toHaveBeenLastCalledWith(
			"!r:x",
			MARKED_UNREAD_TYPE,
			{ unread: true },
		);
		harness.dispose();
	});

	it("consumes on reopen after leaving the room view", () => {
		const harness = makeConsumerHarness({ markedUnread: false });
		harness.setRoomId("!r:x");
		markRoomUnread(harness.ctx, "!r:x");
		harness.setRoomId(undefined); // back to the list
		expect(harness.summaries["!r:x"].markedUnread).toBe(true);
		harness.setRoomId("!r:x"); // reopen
		expect(harness.summaries["!r:x"].markedUnread).toBe(false);
		harness.dispose();
	});

	/** Reactive-store harness: the entry-identity vs field-write tracking
	 *  distinction only exists with a real Solid store. */
	function makeStoreHarness() {
		const room = createMockRoom("!r:x");
		const client = createMockClient(new Map([[room.roomId, room]]));
		const [summaries, setSummaries] = createStore<SummariesStore>({});
		const ctx = {
			client: client as unknown as MatrixClient,
			summaries,
			optimisticallySetMarkedUnread: (roomId: string, value: boolean) => {
				if (summaries[roomId]) setSummaries(roomId, "markedUnread", value);
			},
		};
		const [roomId, setRoomId] = createSignal<string | undefined>(undefined);
		const dispose = createRoot((d) => {
			useMarkedUnreadConsumer(ctx, roomId);
			return d;
		});
		return { client, summaries, setSummaries, setRoomId, dispose };
	}

	it("waits for the summary entry (cold-launch restore) and clears once it arrives", () => {
		const h = makeStoreHarness();
		h.setRoomId("!r:x"); // route restored before the initial sync
		expect(h.client.setRoomAccountData).not.toHaveBeenCalled();
		h.setSummaries("!r:x", summary("!r:x", { markedUnread: true }));
		expect(h.summaries["!r:x"].markedUnread).toBe(false);
		expect(h.client.setRoomAccountData).toHaveBeenCalledWith(
			"!r:x",
			MARKED_UNREAD_TYPE,
			{ unread: false },
		);
		h.dispose();
	});

	it("a field-level flag write on the open room does not re-trigger consumption", () => {
		const h = makeStoreHarness();
		h.setSummaries("!r:x", summary("!r:x"));
		h.setRoomId("!r:x"); // opened while read: nothing to clear
		expect(h.client.setRoomAccountData).not.toHaveBeenCalled();
		// The flag arrives while the room is open (sync echo / other device).
		h.setSummaries("!r:x", "markedUnread", true);
		expect(h.client.setRoomAccountData).not.toHaveBeenCalled();
		expect(h.summaries["!r:x"].markedUnread).toBe(true);
		h.dispose();
	});

	it("a remount with the same room open does not consume a mark made while open", () => {
		// Simulates Layout being re-created on a route-definition boundary
		// crossing (e.g. a settings round-trip) while the room stays open.
		const harness = makeConsumerHarness({ markedUnread: false });
		harness.setRoomId("!r:x");
		markRoomUnread(harness.ctx, "!r:x");
		harness.dispose();

		const [roomId2] = createSignal<string | undefined>("!r:x");
		const dispose2 = createRoot((d) => {
			useMarkedUnreadConsumer(harness.ctx, roomId2);
			return d;
		});
		expect(harness.summaries["!r:x"].markedUnread).toBe(true);
		dispose2();
	});
});
