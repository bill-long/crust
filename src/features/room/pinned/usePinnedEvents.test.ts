import { EventType, type MatrixClient, RoomStateEvent } from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { usePinnedEvents } from "./usePinnedEvents";

const PINNED_TYPE = EventType.RoomPinnedEvents;

function withRoot(fn: (dispose: () => void) => Promise<void>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		createRoot(async (dispose) => {
			let disposed = false;
			const safeDispose = () => {
				if (!disposed) {
					disposed = true;
					dispose();
				}
			};
			try {
				await fn(safeDispose);
				safeDispose();
				resolve();
			} catch (e) {
				safeDispose();
				reject(e);
			}
		});
	});
}

function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeStateEvent(roomId: string, content: Record<string, unknown>) {
	return {
		getType: () => PINNED_TYPE,
		getRoomId: () => roomId,
		getContent: () => content,
		getStateKey: () => "",
	} as unknown as Parameters<MatrixClient["emit"]>[1];
}

describe("usePinnedEvents", () => {
	it("returns [] when no pinned state event is present", async () => {
		const room = createMockRoom("!r:x");
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const pins = usePinnedEvents(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			await flushPromises();
			expect(pins.pinnedIds()).toEqual([]);
			expect(pins.displayOrder()).toEqual([]);
			expect(pins.isPinned("$a")).toBe(false);
		});
	});

	it("reflects an existing pinned array (oldest first, displayOrder newest first)", async () => {
		const room = createMockRoom("!r:x");
		room.__setStateEvent(PINNED_TYPE, "", { pinned: ["$a", "$b", "$c"] });
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const pins = usePinnedEvents(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(pins.pinnedIds()).toEqual(["$a", "$b", "$c"]);
			expect(pins.displayOrder()).toEqual(["$c", "$b", "$a"]);
			expect(pins.isPinned("$b")).toBe(true);
			expect(pins.isPinned("$z")).toBe(false);
		});
	});

	it("pin() optimistically appends the id and calls sendStateEvent", async () => {
		const room = createMockRoom("!r:x");
		room.__setStateEvent(PINNED_TYPE, "", { pinned: ["$a"] });
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const pins = usePinnedEvents(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			const p = pins.pin("$new");
			// Overlay applied synchronously before the await.
			expect(pins.pinnedIds()).toEqual(["$a", "$new"]);
			expect(pins.pending()).toBe(true);
			await p;
			expect(client.sendStateEvent).toHaveBeenCalledWith(
				"!r:x",
				PINNED_TYPE,
				{ pinned: ["$a", "$new"] },
				"",
			);
			expect(pins.pending()).toBe(false);
			// Overlay survives until a RoomStateEvent.Events echo clears it.
			expect(pins.pinnedIds()).toEqual(["$a", "$new"]);
		});
	});

	it("unpin() optimistically removes the id", async () => {
		const room = createMockRoom("!r:x");
		room.__setStateEvent(PINNED_TYPE, "", { pinned: ["$a", "$b"] });
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const pins = usePinnedEvents(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			const p = pins.unpin("$a");
			expect(pins.pinnedIds()).toEqual(["$b"]);
			await p;
			expect(client.sendStateEvent).toHaveBeenCalledWith(
				"!r:x",
				PINNED_TYPE,
				{ pinned: ["$b"] },
				"",
			);
		});
	});

	it("clears the optimistic overlay on any subsequent RoomStateEvent.Events for this room/type", async () => {
		const room = createMockRoom("!r:x");
		room.__setStateEvent(PINNED_TYPE, "", { pinned: ["$a"] });
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const pins = usePinnedEvents(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			await pins.pin("$new");
			expect(pins.pinnedIds()).toEqual(["$a", "$new"]);

			// Server confirms with a different array (e.g. concurrent edit).
			room.__setStateEvent(PINNED_TYPE, "", { pinned: ["$a", "$other"] });
			client.__emit(
				RoomStateEvent.Events,
				makeStateEvent("!r:x", { pinned: ["$a", "$other"] }),
			);

			expect(pins.pinnedIds()).toEqual(["$a", "$other"]);
		});
	});

	it("ignores RoomStateEvent.Events for unrelated rooms or types", async () => {
		const room = createMockRoom("!r:x");
		room.__setStateEvent(PINNED_TYPE, "", { pinned: ["$a"] });
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const pins = usePinnedEvents(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			await pins.pin("$new");
			expect(pins.pinnedIds()).toEqual(["$a", "$new"]);

			client.__emit(
				RoomStateEvent.Events,
				makeStateEvent("!other:x", { pinned: [] }),
			);
			client.__emit(RoomStateEvent.Events, {
				getType: () => "m.room.topic",
				getRoomId: () => "!r:x",
				getContent: () => ({}),
				getStateKey: () => "",
			});

			// Overlay survives.
			expect(pins.pinnedIds()).toEqual(["$a", "$new"]);
		});
	});

	it("rolls back overlay and surfaces lastError on sendStateEvent failure", async () => {
		const room = createMockRoom("!r:x");
		room.__setStateEvent(PINNED_TYPE, "", { pinned: ["$a"] });
		const client = createMockClient(new Map([["!r:x", room]]));
		client.sendStateEvent.mockRejectedValueOnce(new Error("M_FORBIDDEN"));
		await withRoot(async () => {
			const pins = usePinnedEvents(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			await pins.pin("$new");
			expect(pins.pinnedIds()).toEqual(["$a"]);
			expect(pins.lastError()).toBe("M_FORBIDDEN");
			expect(pins.pending()).toBe(false);

			pins.clearError();
			expect(pins.lastError()).toBeNull();
		});
	});

	it("canPin reflects maySendStateEvent and re-evaluates on RoomStateEvent.Update", async () => {
		const room = createMockRoom("!r:x");
		room.__setCanSendStateEvent(PINNED_TYPE, false);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const pins = usePinnedEvents(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			await flushPromises();
			expect(pins.canPin()).toBe(false);

			room.__setCanSendStateEvent(PINNED_TYPE, true);
			room.__emit(RoomStateEvent.Update);

			expect(pins.canPin()).toBe(true);
		});
	});

	it("canPin recovers when the Room appears after mount (deep-link before sync)", async () => {
		// Hook mounts when client.getRoom returns undefined; once
		// ClientEvent.Room fires for our roomId, canPin must re-evaluate.
		const rooms = new Map();
		const client = createMockClient(rooms);
		await withRoot(async () => {
			const pins = usePinnedEvents(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			await flushPromises();
			expect(pins.canPin()).toBe(false);
			expect(pins.pinnedIds()).toEqual([]);

			const room = createMockRoom("!r:x");
			room.__setCanSendStateEvent(PINNED_TYPE, true);
			room.__setStateEvent(PINNED_TYPE, "", { pinned: ["$a"] });
			rooms.set("!r:x", room);
			client.__emit("Room", room);

			expect(pins.canPin()).toBe(true);
			expect(pins.pinnedIds()).toEqual(["$a"]);
		});
	});
});
