import { EventType, type MatrixClient } from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PowerLevelContent } from "./powerLevelPresets";

const mocks = vi.hoisted(() => ({
	plContent: null as PowerLevelContent | null,
	perms: {
		canSetPowerLevels: vi.fn(),
		canChangePowerLevel: vi.fn(),
		canKickTarget: vi.fn(),
		canBanTarget: vi.fn(),
	},
}));

vi.mock("./useRoomPermissions", () => ({
	useRoomPermissions: (_client: MatrixClient, roomId: () => string) => ({
		...mocks.perms,
		canKickTarget: (userId: string) =>
			mocks.perms.canKickTarget(userId, roomId()),
		canBanTarget: (userId: string) =>
			mocks.perms.canBanTarget(userId, roomId()),
	}),
}));

vi.mock("./useRoomStateContent", () => ({
	useRoomStateContent: () => () => mocks.plContent,
}));

import {
	type MemberAction,
	performKickOrBan,
	useModerationActions,
} from "./useModerationActions";

const ROOM_ID = "!room:example.com";
const ALICE = "@alice:example.com";
const BOB = "@bob:example.com";
const CAROL = "@carol:example.com";

const promoteMod: MemberAction = {
	kind: "promote-mod",
	userId: ALICE,
	displayName: "Alice",
};
const promoteAdmin: MemberAction = {
	kind: "promote-admin",
	userId: ALICE,
	displayName: "Alice",
};
const demote: MemberAction = {
	kind: "demote",
	userId: ALICE,
	displayName: "Alice",
};
const kick: MemberAction = {
	kind: "kick",
	userId: ALICE,
	displayName: "Alice",
};
const ban: MemberAction = {
	kind: "ban",
	userId: ALICE,
	displayName: "Alice",
};

interface TestClient {
	client: MatrixClient;
	sendStateEvent: ReturnType<typeof vi.fn>;
	kick: ReturnType<typeof vi.fn>;
	ban: ReturnType<typeof vi.fn>;
	roomContents: Map<string, PowerLevelContent | null>;
}

function createClient(): TestClient {
	const sendStateEvent = vi.fn().mockResolvedValue({ event_id: "$state" });
	const kickUser = vi.fn().mockResolvedValue({});
	const banUser = vi.fn().mockResolvedValue({});
	const roomContents = new Map<string, PowerLevelContent | null>([
		[ROOM_ID, mocks.plContent],
	]);
	return {
		client: {
			sendStateEvent,
			kick: kickUser,
			ban: banUser,
			getRoom: (roomId: string) => {
				if (!roomContents.has(roomId)) return null;
				return {
					currentState: {
						getStateEvents: () => {
							const content = roomContents.get(roomId);
							return content === null ? null : { getContent: () => content };
						},
					},
				};
			},
		} as unknown as MatrixClient,
		sendStateEvent,
		kick: kickUser,
		ban: banUser,
		roomContents,
	};
}

function mount(
	client: MatrixClient,
	options?: { roomId?: () => string; parkKickBan?: (a: MemberAction) => void },
) {
	return createRoot((dispose) => ({
		dispose,
		actions: useModerationActions(
			client,
			options?.roomId ?? (() => ROOM_ID),
			options?.parkKickBan ? { parkKickBan: options.parkKickBan } : undefined,
		),
	}));
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	mocks.plContent = {
		users: { [ALICE]: 0, [BOB]: 0, [CAROL]: 0 },
		users_default: 0,
		events: { "m.room.name": 50 },
	};
	mocks.perms.canSetPowerLevels.mockReset().mockReturnValue(true);
	mocks.perms.canChangePowerLevel.mockReset().mockReturnValue(true);
	mocks.perms.canKickTarget.mockReset().mockReturnValue(true);
	mocks.perms.canBanTarget.mockReset().mockReturnValue(true);
});

describe("performKickOrBan", () => {
	it("dispatches kick and ban to the captured room", async () => {
		const client = createClient();

		await performKickOrBan(client.client, ROOM_ID, kick);
		await performKickOrBan(client.client, ROOM_ID, ban);

		expect(client.kick).toHaveBeenCalledWith(ROOM_ID, ALICE);
		expect(client.ban).toHaveBeenCalledWith(ROOM_ID, ALICE);
	});

	it("rejects a malformed non-kick/ban request", async () => {
		const client = createClient();

		await expect(
			performKickOrBan(client.client, ROOM_ID, promoteMod),
		).rejects.toThrow("Not a kick/ban action: promote-mod");
		expect(client.kick).not.toHaveBeenCalled();
		expect(client.ban).not.toHaveBeenCalled();
	});
});

describe("useModerationActions routing and permissions", () => {
	it("parks kick and ban locally until the caller confirms", () => {
		const client = createClient();
		const { actions, dispose } = mount(client.client);

		actions.requestAction(kick);
		expect(actions.pendingAction()).toBe(kick);
		actions.setPendingAction(null);
		actions.requestAction(ban);
		expect(actions.pendingAction()).toBe(ban);
		expect(client.kick).not.toHaveBeenCalled();
		expect(client.ban).not.toHaveBeenCalled();
		dispose();
	});

	it("confirms a parked kick in the room where it was requested", async () => {
		const client = createClient();
		let currentRoomId = ROOM_ID;
		mocks.perms.canKickTarget.mockImplementation(
			(_userId: string, permissionRoomId: string) =>
				permissionRoomId === ROOM_ID,
		);
		const { actions, dispose } = mount(client.client, {
			roomId: () => currentRoomId,
		});

		actions.requestAction(kick);
		currentRoomId = "!other:example.com";
		await actions.performKickOrBan({ ...kick });

		expect(client.kick).toHaveBeenCalledWith(ROOM_ID, ALICE);
		expect(mocks.perms.canKickTarget).toHaveBeenLastCalledWith(ALICE, ROOM_ID);
		dispose();
	});

	it("rejects a confirmation that does not match the parked action", async () => {
		const client = createClient();
		const { actions, dispose } = mount(client.client);

		actions.requestAction(kick);
		await expect(actions.performKickOrBan(ban)).rejects.toThrow(
			"This moderation action is no longer pending.",
		);

		expect(client.kick).not.toHaveBeenCalled();
		expect(client.ban).not.toHaveBeenCalled();
		dispose();
	});

	it("uses an external parking callback when supplied", () => {
		const client = createClient();
		const parkKickBan = vi.fn();
		const { actions, dispose } = mount(client.client, { parkKickBan });

		actions.requestAction(kick);

		expect(parkKickBan).toHaveBeenCalledWith(kick);
		expect(actions.pendingAction()).toBeNull();
		dispose();
	});

	it("revalidates kick and ban permissions at confirmation time", async () => {
		const client = createClient();
		const { actions, dispose } = mount(client.client);
		mocks.perms.canKickTarget.mockReturnValue(false);
		mocks.perms.canBanTarget.mockReturnValue(false);

		await expect(actions.performKickOrBan(kick)).rejects.toThrow(
			"You can no longer kick Alice.",
		);
		await expect(actions.performKickOrBan(ban)).rejects.toThrow(
			"You can no longer ban Alice.",
		);
		expect(client.kick).not.toHaveBeenCalled();
		expect(client.ban).not.toHaveBeenCalled();
		dispose();
	});

	it("forwards valid confirmations and rejects invalid action kinds", async () => {
		const client = createClient();
		const { actions, dispose } = mount(client.client);

		await actions.performKickOrBan(kick);
		await actions.performKickOrBan(ban);
		await expect(actions.performKickOrBan(promoteAdmin)).rejects.toThrow(
			"Not a kick/ban action: promote-admin",
		);
		expect(client.kick).toHaveBeenCalledWith(ROOM_ID, ALICE);
		expect(client.ban).toHaveBeenCalledWith(ROOM_ID, ALICE);
		dispose();
	});

	it("reports the precise reason a promotion is no longer allowed", async () => {
		const client = createClient();
		const { actions, dispose } = mount(client.client);
		mocks.perms.canChangePowerLevel.mockReturnValue(false);

		actions.requestAction(promoteMod);
		await vi.waitFor(() =>
			expect(actions.actionError()).toBe(
				"You can't change this member's power level.",
			),
		);

		mocks.perms.canSetPowerLevels.mockReturnValue(false);
		actions.requestAction(promoteAdmin);
		await vi.waitFor(() =>
			expect(actions.actionError()).toBe(
				"You don't have permission to change power levels.",
			),
		);
		expect(client.sendStateEvent).not.toHaveBeenCalled();
		dispose();
	});

	it("derives action availability from permissions and demotion baseline", () => {
		const client = createClient();
		const { actions, dispose } = mount(client.client);
		mocks.perms.canChangePowerLevel.mockImplementation(
			(userId: string, level: number) => userId === ALICE && level === 50,
		);

		expect(actions.canPromoteMod(ALICE)).toBe(true);
		expect(actions.canPromoteAdmin(ALICE)).toBe(false);
		expect(actions.canDemote(ALICE, 50)).toBe(false);
		expect(actions.canDemote(ALICE, 0)).toBe(false);

		mocks.plContent = { users_default: 25 };
		mocks.perms.canChangePowerLevel.mockReturnValue(true);
		expect(actions.canDemote(ALICE, 50)).toBe(true);
		expect(mocks.perms.canChangePowerLevel).toHaveBeenLastCalledWith(ALICE, 0);
		dispose();
	});
});

describe("useModerationActions power-level writes", () => {
	it("promotes against a cloned snapshot and captures the requested room", async () => {
		const client = createClient();
		let currentRoomId = ROOM_ID;
		const { actions, dispose } = mount(client.client, {
			roomId: () => currentRoomId,
		});
		const originalContent = mocks.plContent;

		actions.requestAction(promoteMod);
		currentRoomId = "!other:example.com";
		mocks.plContent = { users: { "@other:example.com": 100 } };

		await vi.waitFor(() =>
			expect(client.sendStateEvent).toHaveBeenCalledWith(
				ROOM_ID,
				EventType.RoomPowerLevels,
				{
					users: { [ALICE]: 50, [BOB]: 0, [CAROL]: 0 },
					users_default: 0,
					events: { "m.room.name": 50 },
				},
				"",
			),
		);
		expect(originalContent?.users?.[ALICE]).toBe(0);
		dispose();
	});

	it("demotes by deleting the override at baseline zero", async () => {
		const client = createClient();
		mocks.plContent = {
			users: { [ALICE]: 50, [BOB]: 25 },
			users_default: 0,
		};
		client.roomContents.set(ROOM_ID, mocks.plContent);
		const { actions, dispose } = mount(client.client);

		actions.requestAction(demote);

		await vi.waitFor(() =>
			expect(client.sendStateEvent).toHaveBeenCalledOnce(),
		);
		expect(client.sendStateEvent.mock.calls[0]?.[2]).toEqual({
			users: { [BOB]: 25 },
			users_default: 0,
		});
		dispose();
	});

	it("serializes rapid writes and carries a successful pending snapshot forward", async () => {
		const client = createClient();
		const first = deferred<{ event_id: string }>();
		client.sendStateEvent
			.mockImplementationOnce(() => first.promise)
			.mockResolvedValueOnce({ event_id: "$second" });
		const { actions, dispose } = mount(client.client);

		actions.requestAction(promoteMod);
		actions.requestAction({ ...promoteMod, userId: BOB, displayName: "Bob" });
		await vi.waitFor(() =>
			expect(client.sendStateEvent).toHaveBeenCalledOnce(),
		);
		first.resolve({ event_id: "$first" });
		await vi.waitFor(() =>
			expect(client.sendStateEvent).toHaveBeenCalledTimes(2),
		);

		expect(client.sendStateEvent.mock.calls[1]?.[2]).toMatchObject({
			users: { [ALICE]: 50, [BOB]: 50 },
		});
		dispose();
	});

	it("keeps interleaved queued snapshots isolated per room", async () => {
		const client = createClient();
		let currentRoomId = ROOM_ID;
		const { actions, dispose } = mount(client.client, {
			roomId: () => currentRoomId,
		});
		const firstRoomContent = mocks.plContent;

		actions.requestAction(promoteMod);
		currentRoomId = "!other:example.com";
		mocks.plContent = { users: { [BOB]: 0 }, users_default: 0 };
		client.roomContents.set("!other:example.com", mocks.plContent);
		actions.requestAction({ ...promoteMod, userId: BOB, displayName: "Bob" });
		currentRoomId = ROOM_ID;
		mocks.plContent = firstRoomContent;
		actions.requestAction({
			...promoteMod,
			userId: CAROL,
			displayName: "Carol",
		});
		await vi.waitFor(() =>
			expect(client.sendStateEvent).toHaveBeenCalledTimes(3),
		);

		expect(
			client.sendStateEvent.mock.calls.find(
				(call) => call[0] === "!other:example.com",
			),
		).toEqual([
			"!other:example.com",
			EventType.RoomPowerLevels,
			{ users: { [BOB]: 50 }, users_default: 0 },
			"",
		]);
		expect(
			client.sendStateEvent.mock.calls
				.filter((call) => call[0] === ROOM_ID)
				.at(-1)?.[2],
		).toMatchObject({
			users: { [ALICE]: 50, [BOB]: 0, [CAROL]: 50 },
		});
		dispose();
	});

	it("rebases a delayed write on room state that arrived after the request", async () => {
		const client = createClient();
		const otherRoomId = "!other:example.com";
		const externalUser = "@external:example.com";
		const currentRoomId = otherRoomId;
		mocks.plContent = { users: { [BOB]: 0 }, users_default: 0 };
		client.roomContents.set(otherRoomId, mocks.plContent);
		const { actions, dispose } = mount(client.client, {
			roomId: () => currentRoomId,
		});

		actions.requestAction({ ...promoteMod, userId: BOB, displayName: "Bob" });
		client.roomContents.set(otherRoomId, {
			users: { [BOB]: 0, [externalUser]: 75 },
			users_default: 0,
		});

		await vi.waitFor(() =>
			expect(client.sendStateEvent).toHaveBeenCalledOnce(),
		);
		expect(client.sendStateEvent.mock.calls[0]?.[2]).toMatchObject({
			users: { [BOB]: 50, [externalUser]: 75 },
		});
		dispose();
	});

	it("rebases after a failed write and keeps that failure visible", async () => {
		const client = createClient();
		const first = deferred<{ event_id: string }>();
		client.sendStateEvent
			.mockImplementationOnce(() => first.promise)
			.mockResolvedValueOnce({ event_id: "$second" });
		const { actions, dispose } = mount(client.client);

		actions.requestAction(promoteMod);
		actions.requestAction({ ...promoteMod, userId: BOB, displayName: "Bob" });
		await vi.waitFor(() =>
			expect(client.sendStateEvent).toHaveBeenCalledOnce(),
		);
		first.reject(new Error("first write failed"));
		await vi.waitFor(() =>
			expect(client.sendStateEvent).toHaveBeenCalledTimes(2),
		);

		expect(client.sendStateEvent.mock.calls[1]?.[2]).toMatchObject({
			users: { [ALICE]: 0, [BOB]: 50 },
		});
		expect(actions.actionError()).toBe("first write failed");
		dispose();
	});

	it("rolls back only the failed mutation before a third queued write", async () => {
		const client = createClient();
		const first = deferred<{ event_id: string }>();
		const second = deferred<{ event_id: string }>();
		client.sendStateEvent
			.mockImplementationOnce(() => first.promise)
			.mockImplementationOnce(() => second.promise)
			.mockResolvedValueOnce({ event_id: "$third" });
		const { actions, dispose } = mount(client.client);

		actions.requestAction(promoteMod);
		actions.requestAction({ ...promoteMod, userId: BOB, displayName: "Bob" });
		actions.requestAction({
			...promoteMod,
			userId: CAROL,
			displayName: "Carol",
		});
		await vi.waitFor(() =>
			expect(client.sendStateEvent).toHaveBeenCalledOnce(),
		);
		first.resolve({ event_id: "$first" });
		await vi.waitFor(() =>
			expect(client.sendStateEvent).toHaveBeenCalledTimes(2),
		);
		second.reject(new Error("second write failed"));
		await vi.waitFor(() =>
			expect(client.sendStateEvent).toHaveBeenCalledTimes(3),
		);

		expect(client.sendStateEvent.mock.calls[2]?.[2]).toMatchObject({
			users: { [ALICE]: 50, [BOB]: 0, [CAROL]: 50 },
		});
		expect(actions.actionError()).toBe("second write failed");
		dispose();
	});

	it("uses the friendly fallback for browser-level write failures", async () => {
		const client = createClient();
		client.sendStateEvent.mockRejectedValueOnce(
			new TypeError("Failed to fetch"),
		);
		const { actions, dispose } = mount(client.client);

		actions.requestAction(promoteMod);

		await vi.waitFor(() =>
			expect(actions.actionError()).toBe("Action failed."),
		);
		dispose();
	});
});
