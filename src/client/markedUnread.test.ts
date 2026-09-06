import type { MatrixClient, Room } from "matrix-js-sdk";
import { createRoot, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requiredValue } from "../test/assertions";
import { createMockClient, createMockRoom } from "../test/mockClient";
import {
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
		isFavourite: false,
		isLowPriority: false,
		spaceOrder: null,
		isMuted: false,
		membership: "join",
		isEncrypted: false,
		isDirect: false,
		dmUserId: null,
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

	it("is false once the room is unread (count or flag)", () => {
		expect(canMarkRoomUnread(summary("!r:x", { unreadCount: 2 }))).toBe(false);
		expect(canMarkRoomUnread(summary("!r:x", { markedUnread: true }))).toBe(
			false,
		);
	});

	it("is false for a room the user is no longer joined to", () => {
		expect(canMarkRoomUnread(summary("!r:x", { membership: "leave" }))).toBe(
			false,
		);
	});

	it("ignores a muted room's hidden count - the gate matches the badge", () => {
		expect(
			canMarkRoomUnread(summary("!r:x", { unreadCount: 5, isMuted: true })),
		).toBe(true);
		expect(
			canMarkRoomUnread(summary("!r:x", { markedUnread: true, isMuted: true })),
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

	it("rolls back to the authoritative value when the write fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { client, ctx, optimisticallySetMarkedUnread } = makeCtx({
			markedUnread: false,
		});
		client.setRoomAccountData.mockRejectedValueOnce(new Error("nope"));
		markRoomUnread(ctx, "!r:x");
		await flush();
		// No account data on the room: the failed PUT changed nothing, so
		// the rollback converges to false.
		expect(optimisticallySetMarkedUnread).toHaveBeenLastCalledWith(
			"!r:x",
			false,
		);
	});

	it("does not clobber a mid-flight echo the server already confirmed", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { room, client, ctx, summaries } = makeCtx({ markedUnread: false });
		client.setRoomAccountData.mockRejectedValueOnce(new Error("timeout"));
		markRoomUnread(ctx, "!r:x");
		// Before the rejection lands, the server-side echo arrives (the PUT
		// was applied despite the failed response, or another device wrote
		// the same value): the SDK now holds true.
		room.__setRoomAccountData(MARKED_UNREAD_TYPE, { unread: true });
		await flush();
		// Convergent rollback keeps the confirmed value instead of
		// inverting it (an inverted write would stick - /sync never
		// re-delivers unchanged account data).
		expect(requiredValue(summaries["!r:x"], "room summary").markedUnread).toBe(
			true,
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
		const { room, client, ctx, summaries, optimisticallySetMarkedUnread } =
			makeCtx({ markedUnread: true });
		// The authoritative SDK state the rollback converges to: the server
		// still holds the flag (the failed PUT changed nothing).
		room.__setRoomAccountData(MARKED_UNREAD_TYPE, { unread: true });
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
		expect(requiredValue(summaries["!r:x"], "room summary").markedUnread).toBe(
			false,
		);
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
	// No per-test latch reset needed: the consumed latch is keyed per
	// client (WeakMap) and every harness creates a fresh mock client.

	function makeConsumerHarness(opts: { markedUnread: boolean }) {
		const base = makeCtx(opts);
		const [roomId, setRoomId] = createSignal<string | undefined>(undefined);
		const dispose = createRoot((d) => {
			useMarkedUnreadConsumer(base.ctx, roomId);
			return d;
		});
		return { ...base, setRoomId, dispose };
	}

	it("clears the flag when a marked room is opened", async () => {
		const { client, summaries, setRoomId, dispose } = makeConsumerHarness({
			markedUnread: true,
		});
		setRoomId("!r:x");
		await flush(); // consumption runs on a microtask (mid-sync-batch guard)
		expect(requiredValue(summaries["!r:x"], "room summary").markedUnread).toBe(
			false,
		);
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
		expect(
			requiredValue(harness.summaries["!r:x"], "room summary").markedUnread,
		).toBe(true);
		expect(harness.client.setRoomAccountData).toHaveBeenCalledTimes(1);
		expect(harness.client.setRoomAccountData).toHaveBeenLastCalledWith(
			"!r:x",
			MARKED_UNREAD_TYPE,
			{ unread: true },
		);
		harness.dispose();
	});

	it("consumes on reopen after leaving the room view", async () => {
		const harness = makeConsumerHarness({ markedUnread: false });
		harness.setRoomId("!r:x");
		await flush();
		markRoomUnread(harness.ctx, "!r:x");
		harness.setRoomId(undefined); // back to the list
		expect(
			requiredValue(harness.summaries["!r:x"], "room summary").markedUnread,
		).toBe(true);
		harness.setRoomId("!r:x"); // reopen
		await flush();
		expect(
			requiredValue(harness.summaries["!r:x"], "room summary").markedUnread,
		).toBe(false);
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

	it("waits for the summary entry (cold-launch restore) and clears once it arrives", async () => {
		const h = makeStoreHarness();
		h.setRoomId("!r:x"); // route restored before the initial sync
		await flush();
		expect(h.client.setRoomAccountData).not.toHaveBeenCalled();
		h.setSummaries("!r:x", summary("!r:x", { markedUnread: true }));
		await flush();
		expect(
			requiredValue(h.summaries["!r:x"], "room summary").markedUnread,
		).toBe(false);
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
		expect(
			requiredValue(h.summaries["!r:x"], "room summary").markedUnread,
		).toBe(true);
		h.dispose();
	});

	it("re-arms when switching to a room whose entry has not synced yet", async () => {
		const h = makeStoreHarness();
		h.setSummaries("!r:x", summary("!r:x"));
		h.setRoomId("!r:x"); // open (nothing to clear; latch set)
		h.setRoomId("!b:x"); // permalink into an unsynced room: no entry
		// The first room gets marked (another device) while we are away.
		h.setSummaries("!r:x", "markedUnread", true);
		h.setRoomId("!r:x"); // return: a NEW open, so it must consume
		await flush();
		expect(
			requiredValue(h.summaries["!r:x"], "room summary").markedUnread,
		).toBe(false);
		expect(h.client.setRoomAccountData).toHaveBeenCalledWith(
			"!r:x",
			MARKED_UNREAD_TYPE,
			{ unread: false },
		);
		h.dispose();
	});

	it("a remount with the same room open does not consume a mark made while open", () => {
		// Simulates Layout being re-created while the viewed room id stays
		// DEFINED throughout. NOTE: a settings round-trip is NOT this case -
		// /settings clears params.roomId, so the effect re-arms and the
		// return consumes, which the hook docs declare deliberate
		// (open-consumes semantics).
		const harness = makeConsumerHarness({ markedUnread: false });
		harness.setRoomId("!r:x");
		markRoomUnread(harness.ctx, "!r:x");
		harness.dispose();

		const [roomId2] = createSignal<string | undefined>("!r:x");
		const dispose2 = createRoot((d) => {
			useMarkedUnreadConsumer(harness.ctx, roomId2);
			return d;
		});
		expect(
			requiredValue(harness.summaries["!r:x"], "room summary").markedUnread,
		).toBe(true);
		dispose2();
	});
});
