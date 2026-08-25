import type { MatrixClient, Room } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../test/mockClient";
import {
	clearRoomMarkedUnread,
	getRoomMarkedUnread,
	MARKED_UNREAD_TYPE,
	MARKED_UNREAD_TYPE_UNSTABLE,
	markRoomUnread,
} from "./markedUnread";
import type { RoomSummary, SummariesStore } from "./summaries";

function summary(roomId: string, markedUnread: boolean): RoomSummary {
	return {
		roomId,
		name: roomId,
		avatarUrl: null,
		lastMessage: null,
		unreadCount: 0,
		highlightCount: 0,
		markedUnread,
		membership: "join",
		isEncrypted: false,
		isDirect: false,
		isSpace: false,
		kind: "text",
		callActive: false,
		children: [],
	};
}

function makeCtx(opts: { markedUnread: boolean }) {
	const room = createMockRoom("!r:x");
	const client = createMockClient(new Map([[room.roomId, room]]));
	const summaries: SummariesStore = {
		"!r:x": summary("!r:x", opts.markedUnread),
	};
	const optimisticallySetMarkedUnread = vi.fn();
	return {
		room,
		client,
		ctx: {
			client: client as unknown as MatrixClient,
			summaries,
			optimisticallySetMarkedUnread,
		},
		optimisticallySetMarkedUnread,
	};
}

/** Flush the microtask queue so .catch handlers of settled promises run. */
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

	it("stays console-only on write failure (no rollback, no throw)", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const { client, ctx, optimisticallySetMarkedUnread } = makeCtx({
			markedUnread: true,
		});
		client.setRoomAccountData.mockRejectedValueOnce(new Error("nope"));
		clearRoomMarkedUnread(ctx, "!r:x");
		await flush();
		// Only the initial optimistic clear - the flag is NOT flipped back;
		// the authoritative account-data sync corrects it if needed.
		expect(optimisticallySetMarkedUnread).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalled();
	});
});
