import {
	type MatrixClient,
	type MatrixEvent,
	RoomStateEvent,
} from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { useRoomPermissions } from "./useRoomPermissions";

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
	stateKey = "",
): MatrixEvent {
	return {
		getType: () => type,
		getRoomId: () => roomId,
		getStateKey: () => stateKey,
		getContent: () => ({}),
	} as unknown as MatrixEvent;
}

describe("useRoomPermissions", () => {
	it("reports myPowerLevel from the joined member entry", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[
				{
					userId: "@test:example.com",
					name: "Me",
					membership: "join",
					powerLevel: 50,
				},
			],
		);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const perms = useRoomPermissions(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(perms.myPowerLevel()).toBe(50);
			expect(perms.usersDefault()).toBe(0);
		});
	});

	it("derives canSetX from maySendStateEvent and re-derives on PL change", async () => {
		const room = createMockRoom("!r:x");
		const client = createMockClient(new Map([["!r:x", room]]));
		room.__setCanSendStateEvent("m.room.name", false);
		room.__setCanSendStateEvent("m.room.topic", true);
		await withRoot(async () => {
			const perms = useRoomPermissions(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(perms.canSetName()).toBe(false);
			expect(perms.canSetTopic()).toBe(true);
			// Flip the gate; emit the PL event to trigger re-derivation.
			room.__setCanSendStateEvent("m.room.name", true);
			client.__emit(
				RoomStateEvent.Events,
				fakeStateEvent("!r:x", "m.room.power_levels"),
			);
			expect(perms.canSetName()).toBe(true);
		});
	});

	it("requiredPowerLevel honors per-event override, then state_default", async () => {
		const room = createMockRoom("!r:x");
		room.__setStateEvent("m.room.power_levels", "", {
			state_default: 50,
			events: { "m.room.name": 100 },
		});
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const perms = useRoomPermissions(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(perms.requiredPowerLevel("m.room.name")).toBe(100);
			expect(perms.requiredPowerLevel("m.room.topic")).toBe(50);
		});
	});

	it("canKick/canBan/canInvite/canRedact gate on myPowerLevel vs key level", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[
				{
					userId: "@test:example.com",
					name: "Me",
					membership: "join",
					powerLevel: 50,
				},
			],
		);
		room.__setStateEvent("m.room.power_levels", "", {
			invite: 0,
			kick: 50,
			ban: 100,
			redact: 50,
		});
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const perms = useRoomPermissions(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(perms.canInvite()).toBe(true);
			expect(perms.canKick()).toBe(true);
			expect(perms.canBan()).toBe(false);
			expect(perms.canRedact()).toBe(true);
		});
	});

	it("canChangePowerLevel requires both targetPL < myPL AND requestedPL < myPL", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[
				{
					userId: "@test:example.com",
					name: "Me",
					membership: "join",
					powerLevel: 50,
				},
				{
					userId: "@peer:x",
					name: "Peer",
					membership: "join",
					powerLevel: 50,
				},
				{
					userId: "@noob:x",
					name: "Noob",
					membership: "join",
					powerLevel: 0,
				},
			],
		);
		room.__setCanSendStateEvent("m.room.power_levels", true);
		room.__setStateEvent("m.room.power_levels", "", {
			users: { "@test:example.com": 50, "@peer:x": 50, "@noob:x": 0 },
			users_default: 0,
		});
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const perms = useRoomPermissions(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			// Can promote noob to 25 (below my 50).
			expect(perms.canChangePowerLevel("@noob:x", 25)).toBe(true);
			// Cannot promote noob to 50 (equal to my PL — not strictly less).
			expect(perms.canChangePowerLevel("@noob:x", 50)).toBe(false);
			// Cannot touch peer at 50 (target equal to my PL).
			expect(perms.canChangePowerLevel("@peer:x", 0)).toBe(false);
		});
	});

	it("canChangePowerLevel returns false if user lacks PL state-send permission", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[
				{
					userId: "@test:example.com",
					name: "Me",
					membership: "join",
					powerLevel: 100,
				},
				{
					userId: "@noob:x",
					name: "Noob",
					membership: "join",
					powerLevel: 0,
				},
			],
		);
		room.__setCanSendStateEvent("m.room.power_levels", false);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const perms = useRoomPermissions(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(perms.canChangePowerLevel("@noob:x", 50)).toBe(false);
		});
	});

	it("falls back to defaults when events/users contain non-finite numbers", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[
				{
					userId: "@test:example.com",
					name: "Me",
					membership: "join",
					powerLevel: 50,
				},
			],
		);
		room.__setStateEvent("m.room.power_levels", "", {
			state_default: 50,
			users_default: 0,
			events: {
				"m.room.name": Number.NaN,
				"m.room.topic": Number.POSITIVE_INFINITY,
			},
			users: {
				"@bad:x": Number.NaN,
				"@worse:x": Number.NEGATIVE_INFINITY,
			},
		});
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const perms = useRoomPermissions(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			// requiredPowerLevel rejects NaN/Infinity and falls back to state_default.
			expect(perms.requiredPowerLevel("m.room.name")).toBe(50);
			expect(perms.requiredPowerLevel("m.room.topic")).toBe(50);
			// targetPowerLevel rejects NaN/Infinity and falls back to users_default.
			// Caller PL = 50, so @bad/@worse should appear kickable (target PL = 0).
			expect(perms.canKickTarget("@bad:x")).toBe(true);
			expect(perms.canKickTarget("@worse:x")).toBe(true);
		});
	});

	it("re-derives when own m.room.member event arrives (PL change)", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[
				{
					userId: "@test:example.com",
					name: "Me",
					membership: "join",
					powerLevel: 0,
				},
			],
		);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const perms = useRoomPermissions(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(perms.myPowerLevel()).toBe(0);
			// Simulate a promotion landing on /sync.
			room.__addMember({
				userId: "@test:example.com",
				name: "Me",
				membership: "join",
				powerLevel: 100,
			});
			client.__emit(
				RoomStateEvent.Events,
				fakeStateEvent("!r:x", "m.room.member", "@test:example.com"),
			);
			expect(perms.myPowerLevel()).toBe(100);
		});
	});

	it("ignores m.room.member events for other users", async () => {
		const room = createMockRoom(
			"!r:x",
			[],
			[
				{
					userId: "@test:example.com",
					name: "Me",
					membership: "join",
					powerLevel: 0,
				},
			],
		);
		const client = createMockClient(new Map([["!r:x", room]]));
		await withRoot(async () => {
			const perms = useRoomPermissions(
				client as unknown as MatrixClient,
				() => "!r:x",
			);
			expect(perms.myPowerLevel()).toBe(0);
			// Mutate underlying member data without telling the hook, then emit a
			// member event for *another* user. The hook should not retick, so the
			// memo should still report the cached value.
			room.__addMember({
				userId: "@test:example.com",
				name: "Me",
				membership: "join",
				powerLevel: 100,
			});
			client.__emit(
				RoomStateEvent.Events,
				fakeStateEvent("!r:x", "m.room.member", "@other:example.com"),
			);
			expect(perms.myPowerLevel()).toBe(0);
		});
	});
});
