import {
	type MatrixClient,
	type MatrixEvent,
	RoomStateEvent,
} from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { useRoomStateContent } from "./useRoomStateContent";

function withRoot(fn: (dispose: () => void) => Promise<void>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		createRoot(async (dispose) => {
			let disposed = false;
			const safeDispose = (): void => {
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

function fakeStateEvent(
	roomId: string,
	type: string,
	content: Record<string, unknown>,
	stateKey = "",
): MatrixEvent {
	return {
		getType: () => type,
		getRoomId: () => roomId,
		getStateKey: () => stateKey,
		getContent: () => content,
	} as unknown as MatrixEvent;
}

describe("useRoomStateContent", () => {
	it("returns null when the room has no state event", async () => {
		const room = createMockRoom("!r:x");
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const content = useRoomStateContent<{ name?: string }>(
				client as unknown as MatrixClient,
				() => "!r:x",
				"m.room.name",
			);
			expect(content()).toBeNull();
		});
	});

	it("returns the initial server content", async () => {
		const room = createMockRoom("!r:x");
		room.__setStateEvent("m.room.name", "", { name: "Hello" });
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const content = useRoomStateContent<{ name?: string }>(
				client as unknown as MatrixClient,
				() => "!r:x",
				"m.room.name",
			);
			expect(content()?.name).toBe("Hello");
		});
	});

	it("updates when a matching RoomStateEvent.Events fires", async () => {
		const room = createMockRoom("!r:x");
		room.__setStateEvent("m.room.name", "", { name: "Hello" });
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const content = useRoomStateContent<{ name?: string }>(
				client as unknown as MatrixClient,
				() => "!r:x",
				"m.room.name",
			);
			expect(content()?.name).toBe("Hello");

			room.__setStateEvent("m.room.name", "", { name: "World" });
			client.__emit(
				RoomStateEvent.Events,
				fakeStateEvent("!r:x", "m.room.name", { name: "World" }),
			);
			expect(content()?.name).toBe("World");
		});
	});

	it("ignores events for other rooms", async () => {
		const room = createMockRoom("!r:x");
		room.__setStateEvent("m.room.name", "", { name: "Hello" });
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const content = useRoomStateContent<{ name?: string }>(
				client as unknown as MatrixClient,
				() => "!r:x",
				"m.room.name",
			);
			// Echo for a different room should NOT trigger a re-read.
			// Even if it did, the read is from "!r:x" so the value would
			// be unchanged — but the negative assertion here is that the
			// filter rejects the event so subscribers don't churn.
			room.__setStateEvent("m.room.name", "", { name: "Updated" });
			client.__emit(
				RoomStateEvent.Events,
				fakeStateEvent("!other:x", "m.room.name", { name: "Bad" }),
			);
			expect(content()?.name).toBe("Hello");
		});
	});

	it("ignores events for other state types", async () => {
		const room = createMockRoom("!r:x");
		room.__setStateEvent("m.room.name", "", { name: "Hello" });
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const content = useRoomStateContent<{ name?: string }>(
				client as unknown as MatrixClient,
				() => "!r:x",
				"m.room.name",
			);
			room.__setStateEvent("m.room.topic", "", { topic: "T" });
			client.__emit(
				RoomStateEvent.Events,
				fakeStateEvent("!r:x", "m.room.topic", { topic: "T" }),
			);
			expect(content()?.name).toBe("Hello");
		});
	});

	it("returns null when the active room changes to one without the state event", async () => {
		const a = createMockRoom("!a:x");
		a.__setStateEvent("m.room.name", "", { name: "A" });
		const b = createMockRoom("!b:x");
		const client = createMockClient(
			new Map([
				["!a:x", a],
				["!b:x", b],
			]),
		);
		let rid = "!a:x";
		await withRoot(async () => {
			const content = useRoomStateContent<{ name?: string }>(
				client as unknown as MatrixClient,
				() => rid,
				"m.room.name",
			);
			expect(content()?.name).toBe("A");
			rid = "!b:x";
			// Force a re-read by emitting an event for !b:x (the test
			// stand-in for /sync delivering its room state).
			client.__emit(
				RoomStateEvent.Events,
				fakeStateEvent("!b:x", "m.room.name", {}),
			);
			expect(content()).toBeNull();
		});
	});
});
