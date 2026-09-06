import {
	type MatrixClient,
	type RoomMember,
	RoomStateEvent,
} from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { requiredAt } from "../testAssertions";
import { usePendingKnocks } from "./usePendingKnocks";

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

function nextFrame(): Promise<void> {
	return new Promise((resolve) => {
		requestAnimationFrame(() => resolve());
	});
}

describe("usePendingKnocks", () => {
	it("returns members with membership === 'knock' only", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[
				{ userId: "@a:x", name: "Alice", membership: "join" },
				{ userId: "@b:x", name: "Bob", membership: "knock" },
				{ userId: "@c:x", name: "Carol", membership: "knock" },
				{ userId: "@d:x", name: "Dave", membership: "invite" },
			],
		);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const knocks = usePendingKnocks(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(knocks().map((k) => k.userId)).toEqual(["@b:x", "@c:x"]);
		});
	});

	it("sorts knocks by displayName", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[
				{ userId: "@z:x", name: "Zara", membership: "knock" },
				{ userId: "@a:x", name: "Anya", membership: "knock" },
			],
		);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const knocks = usePendingKnocks(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(knocks().map((k) => k.displayName)).toEqual(["Anya", "Zara"]);
		});
	});

	it("surfaces the knock reason from the member event, trimmed", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[{ userId: "@b:x", name: "Bob", membership: "knock" }],
		);
		// The mock room's member entries carry no member event; attach one
		// the way the SDK's RoomMember.events.member presents it.
		const member = room.getMember("@b:x") as unknown as Record<string, unknown>;
		member.events = {
			member: {
				getContent: () => ({ membership: "knock", reason: "  let me in  " }),
				getTs: () => 1234,
				getSender: () => "@b:x",
			},
		};
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const knocks = usePendingKnocks(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(knocks()).toHaveLength(1);
			const knock = requiredAt(knocks(), 0, "pending knock");
			expect(knock.reason).toBe("let me in");
			expect(knock.knockedAt).toBe(1234);
		});
	});

	it("returns a null reason when the member event has none", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[{ userId: "@b:x", name: "Bob", membership: "knock" }],
		);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const knocks = usePendingKnocks(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(requiredAt(knocks(), 0, "pending knock").reason).toBeNull();
		});
	});

	it("refreshes when RoomStateEvent.Members fires for the room", async () => {
		const room = createMockRoom("!r:x", [], []);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const knocks = usePendingKnocks(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(knocks().length).toBe(0);
			room.__addMember({
				userId: "@new:x",
				name: "Newbie",
				membership: "knock",
			});
			client.__emit(RoomStateEvent.Members, null, null, {
				roomId: "!r:x",
			} as unknown as RoomMember);
			await nextFrame();
			expect(knocks().map((k) => k.userId)).toEqual(["@new:x"]);
		});
	});

	it("ignores Members events for other rooms", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[{ userId: "@b:x", name: "Bob", membership: "knock" }],
		);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const knocks = usePendingKnocks(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(knocks().length).toBe(1);
			client.__emit(RoomStateEvent.Members, null, null, {
				roomId: "!other:x",
			} as unknown as RoomMember);
			await nextFrame();
			expect(knocks().length).toBe(1);
		});
	});

	it("drops members that flip away from knock (approved or declined)", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[{ userId: "@b:x", name: "Bob", membership: "knock" }],
		);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const knocks = usePendingKnocks(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(knocks().length).toBe(1);
			room.__addMember({
				userId: "@b:x",
				name: "Bob",
				membership: "join",
			});
			client.__emit(RoomStateEvent.Members, null, null, {
				roomId: "!r:x",
			} as unknown as RoomMember);
			await nextFrame();
			expect(knocks().length).toBe(0);
		});
	});
});
