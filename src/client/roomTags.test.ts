import type { MatrixClient, Room } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockClient, createMockRoom } from "../test/mockClient";
import {
	FAVOURITE_TAG,
	getRoomTagState,
	LOW_PRIORITY_TAG,
	toggleRoomTag,
} from "./roomTags";
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

function makeCtx(overrides: Partial<RoomSummary> = {}) {
	const room = createMockRoom("!r:x");
	const client = createMockClient(new Map([[room.roomId, room]]));
	const summaries: SummariesStore = { "!r:x": summary("!r:x", overrides) };
	const optimisticallySetRoomTag = vi.fn(
		(roomId: string, tag: string, value: boolean) => {
			const s = summaries[roomId];
			if (!s) return;
			if (tag === FAVOURITE_TAG) s.isFavourite = value;
			else s.isLowPriority = value;
		},
	);
	return {
		room,
		client,
		summaries,
		optimisticallySetRoomTag,
		ctx: {
			client: client as unknown as MatrixClient,
			summaries,
			optimisticallySetRoomTag,
		},
	};
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
	vi.restoreAllMocks();
});

describe("getRoomTagState", () => {
	it("reads the two sidebar tags and ignores custom ones", () => {
		const room = createMockRoom("!r:x") as unknown as Room;
		(room as unknown as { tags: Record<string, unknown> }).tags = {
			[FAVOURITE_TAG]: {},
			"u.custom": {},
		};
		expect(getRoomTagState(room)).toEqual({
			favourite: true,
			lowPriority: false,
		});
	});
});

describe("toggleRoomTag", () => {
	it("sets the tag optimistically and PUTs it when currently unset", () => {
		const { client, ctx, optimisticallySetRoomTag } = makeCtx();
		toggleRoomTag(ctx, "!r:x", FAVOURITE_TAG);
		expect(optimisticallySetRoomTag).toHaveBeenCalledWith(
			"!r:x",
			FAVOURITE_TAG,
			true,
		);
		expect(client.setRoomTag).toHaveBeenCalledWith("!r:x", FAVOURITE_TAG, {});
		expect(client.deleteRoomTag).not.toHaveBeenCalled();
	});

	it("clears the tag optimistically and DELETEs it when currently set", () => {
		const { client, ctx, optimisticallySetRoomTag } = makeCtx({
			isLowPriority: true,
		});
		toggleRoomTag(ctx, "!r:x", LOW_PRIORITY_TAG);
		expect(optimisticallySetRoomTag).toHaveBeenCalledWith(
			"!r:x",
			LOW_PRIORITY_TAG,
			false,
		);
		expect(client.deleteRoomTag).toHaveBeenCalledWith("!r:x", LOW_PRIORITY_TAG);
		expect(client.setRoomTag).not.toHaveBeenCalled();
	});

	it("no-ops for a room with no summary entry", () => {
		const { client, ctx } = makeCtx();
		toggleRoomTag(ctx, "!missing:x", FAVOURITE_TAG);
		expect(client.setRoomTag).not.toHaveBeenCalled();
		expect(client.deleteRoomTag).not.toHaveBeenCalled();
	});

	it("converges to the authoritative SDK tag state when the write fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { room, client, ctx, summaries } = makeCtx();
		// The server still holds no tag (the failed PUT changed nothing).
		(room as unknown as { tags: Record<string, unknown> }).tags = {};
		client.setRoomTag.mockRejectedValueOnce(new Error("nope"));
		toggleRoomTag(ctx, "!r:x", FAVOURITE_TAG);
		expect(summaries["!r:x"].isFavourite).toBe(true); // optimistic
		await flush();
		expect(summaries["!r:x"].isFavourite).toBe(false); // converged back
	});

	it("keeps a mid-flight authoritative echo instead of inverting it", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { room, client, ctx, summaries } = makeCtx();
		client.setRoomTag.mockRejectedValueOnce(new Error("timeout"));
		toggleRoomTag(ctx, "!r:x", FAVOURITE_TAG);
		// The tag write was applied server-side despite the failed response;
		// the SDK's tags map already reflects it when the rejection lands.
		(room as unknown as { tags: Record<string, unknown> }).tags = {
			[FAVOURITE_TAG]: {},
		};
		await flush();
		expect(summaries["!r:x"].isFavourite).toBe(true);
	});

	it("serializes a rapid double-toggle so PUT and DELETE cannot race", async () => {
		const { client, ctx } = makeCtx();
		let resolveFirst: (v: unknown) => void = () => {};
		client.setRoomTag.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolveFirst = r;
				}),
		);
		toggleRoomTag(ctx, "!r:x", FAVOURITE_TAG); // PUT held in flight
		toggleRoomTag(ctx, "!r:x", FAVOURITE_TAG); // DELETE must queue behind
		await flush();
		expect(client.deleteRoomTag).not.toHaveBeenCalled();
		resolveFirst({});
		await flush();
		expect(client.deleteRoomTag).toHaveBeenCalledWith("!r:x", FAVOURITE_TAG);
	});
});
