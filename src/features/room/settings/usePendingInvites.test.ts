import {
	type MatrixClient,
	type RoomMember,
	RoomStateEvent,
} from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { usePendingInvites } from "./usePendingInvites";

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

describe("usePendingInvites", () => {
	it("returns members with membership === 'invite' only", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[
				{ userId: "@a:x", name: "Alice", membership: "join" },
				{ userId: "@b:x", name: "Bob", membership: "invite" },
				{ userId: "@c:x", name: "Carol", membership: "invite" },
				{ userId: "@d:x", name: "Dave", membership: "leave" },
			],
		);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const invites = usePendingInvites(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			const ids = invites().map((i) => i.userId);
			expect(ids).toEqual(["@b:x", "@c:x"]);
		});
	});

	it("sorts invites by displayName", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[
				{ userId: "@z:x", name: "Zara", membership: "invite" },
				{ userId: "@a:x", name: "Anya", membership: "invite" },
				{ userId: "@m:x", name: "Mike", membership: "invite" },
			],
		);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const invites = usePendingInvites(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(invites().map((i) => i.displayName)).toEqual([
				"Anya",
				"Mike",
				"Zara",
			]);
		});
	});

	it("refreshes when RoomStateEvent.Members fires for the room", async () => {
		const room = createMockRoom("!r:x", [], []);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const invites = usePendingInvites(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(invites().length).toBe(0);
			room.__addMember({
				userId: "@new:x",
				name: "Newbie",
				membership: "invite",
			});
			client.__emit(RoomStateEvent.Members, null, null, {
				roomId: "!r:x",
			} as unknown as RoomMember);
			await nextFrame();
			expect(invites().map((i) => i.userId)).toEqual(["@new:x"]);
		});
	});

	it("ignores Members events for other rooms", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[{ userId: "@b:x", name: "Bob", membership: "invite" }],
		);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const invites = usePendingInvites(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(invites().length).toBe(1);
			// Emit for a different room — must be a no-op.
			client.__emit(RoomStateEvent.Members, null, null, {
				roomId: "!other:x",
			} as unknown as RoomMember);
			await nextFrame();
			expect(invites().length).toBe(1);
		});
	});

	it("drops members that flip away from invite", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[{ userId: "@b:x", name: "Bob", membership: "invite" }],
		);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const invites = usePendingInvites(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(invites().length).toBe(1);
			room.__addMember({
				userId: "@b:x",
				name: "Bob",
				membership: "join",
			});
			client.__emit(RoomStateEvent.Members, null, null, {
				roomId: "!r:x",
			} as unknown as RoomMember);
			await nextFrame();
			expect(invites().length).toBe(0);
		});
	});
});
