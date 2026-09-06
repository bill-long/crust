import type { MatrixClient } from "matrix-js-sdk";
import {
	ConditionKind,
	PushRuleActionName,
	PushRuleKind,
	TweakName,
} from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	getRoomNotificationLevel,
	setRoomNotificationLevel,
} from "./roomNotificationLevel";
import { requiredAt } from "./testAssertions";

const ROOM_ID = "!room:example.com";
const MUTE_RULE_ID = `crust.mute.${ROOM_ID}`;

function clientWithRules(pushRules: unknown): MatrixClient {
	return { pushRules } as unknown as MatrixClient;
}

function writableClient(pushRules: unknown = undefined) {
	return {
		pushRules,
		addPushRule: vi.fn(() => Promise.resolve()),
		deletePushRule: vi.fn(() => Promise.resolve()),
	} as unknown as MatrixClient;
}

function rules(options: { override?: unknown; room?: unknown }): unknown {
	return {
		global: {
			override: options.override,
			room: options.room,
		},
	};
}

describe("getRoomNotificationLevel", () => {
	it("defaults when push rules or matching room rules are absent", () => {
		expect(getRoomNotificationLevel(clientWithRules(undefined), ROOM_ID)).toBe(
			"default",
		);
		expect(getRoomNotificationLevel(clientWithRules({}), ROOM_ID)).toBe(
			"default",
		);
		expect(
			getRoomNotificationLevel(
				clientWithRules(
					rules({
						override: [{ rule_id: "other", enabled: true, actions: [] }],
						room: [{ rule_id: "!other:example.com", actions: [] }],
					}),
				),
				ROOM_ID,
			),
		).toBe("default");
	});

	it("gives an enabled Crust mute override priority over room rules", () => {
		const client = clientWithRules(
			rules({
				override: [
					{
						rule_id: MUTE_RULE_ID,
						enabled: true,
						actions: [PushRuleActionName.DontNotify],
					},
				],
				room: [
					{
						rule_id: ROOM_ID,
						actions: [PushRuleActionName.Notify],
					},
				],
			}),
		);

		expect(getRoomNotificationLevel(client, ROOM_ID)).toBe("mute");
	});

	it("ignores disabled rules and recognizes both room action levels", () => {
		const disabledMute = {
			rule_id: MUTE_RULE_ID,
			enabled: false,
			actions: [PushRuleActionName.DontNotify],
		};
		const roomRule = {
			rule_id: ROOM_ID,
			enabled: true,
			actions: [PushRuleActionName.Notify],
		};
		const client = clientWithRules(
			rules({ override: [disabledMute], room: [roomRule] }),
		);
		expect(getRoomNotificationLevel(client, ROOM_ID)).toBe("all-messages");

		roomRule.actions = [PushRuleActionName.DontNotify];
		expect(getRoomNotificationLevel(client, ROOM_ID)).toBe("mentions-only");

		roomRule.enabled = false;
		expect(getRoomNotificationLevel(client, ROOM_ID)).toBe("default");
	});

	it("treats dont_notify as mentions-only when a rule also contains notify", () => {
		const client = clientWithRules(
			rules({
				room: [
					{
						rule_id: ROOM_ID,
						actions: [PushRuleActionName.Notify, PushRuleActionName.DontNotify],
					},
				],
			}),
		);

		expect(getRoomNotificationLevel(client, ROOM_ID)).toBe("mentions-only");
	});

	it("fails closed to default for malformed cached rule collections and actions", () => {
		const malformed = [
			rules({ override: {}, room: "not-an-array" }),
			rules({ override: [null], room: [null] }),
			rules({ room: [{ rule_id: ROOM_ID }] }),
			rules({ room: [{ rule_id: ROOM_ID, actions: null }] }),
			rules({ room: [{ rule_id: ROOM_ID, actions: ["unknown"] }] }),
		];

		for (const pushRules of malformed) {
			expect(
				getRoomNotificationLevel(clientWithRules(pushRules), ROOM_ID),
			).toBe("default");
		}
	});
});

describe("setRoomNotificationLevel", () => {
	it("does nothing when the requested level is already effective", async () => {
		const client = writableClient(
			rules({
				room: [
					{
						rule_id: ROOM_ID,
						actions: [PushRuleActionName.Notify],
					},
				],
			}),
		);

		await setRoomNotificationLevel(client, ROOM_ID, "all-messages");
		expect(client.addPushRule).not.toHaveBeenCalled();
		expect(client.deletePushRule).not.toHaveBeenCalled();
	});

	it("writes all-messages before deleting a stale mute override", async () => {
		const client = writableClient();

		await setRoomNotificationLevel(client, ROOM_ID, "all-messages");

		expect(client.addPushRule).toHaveBeenCalledWith(
			"global",
			PushRuleKind.RoomSpecific,
			ROOM_ID,
			{
				actions: [
					PushRuleActionName.Notify,
					{ set_tweak: TweakName.Sound, value: "default" },
				],
			},
		);
		expect(client.deletePushRule).toHaveBeenCalledWith(
			"global",
			PushRuleKind.Override,
			MUTE_RULE_ID,
		);
		expect(
			requiredAt(
				vi.mocked(client.addPushRule).mock.invocationCallOrder,
				0,
				"add rule order",
			),
		).toBeLessThan(
			requiredAt(
				vi.mocked(client.deletePushRule).mock.invocationCallOrder,
				0,
				"delete rule order",
			),
		);
	});

	it("writes mentions-only before deleting a stale mute override", async () => {
		const client = writableClient();

		await setRoomNotificationLevel(client, ROOM_ID, "mentions-only");

		expect(client.addPushRule).toHaveBeenCalledWith(
			"global",
			PushRuleKind.RoomSpecific,
			ROOM_ID,
			{ actions: [PushRuleActionName.DontNotify] },
		);
		expect(client.deletePushRule).toHaveBeenCalledWith(
			"global",
			PushRuleKind.Override,
			MUTE_RULE_ID,
		);
	});

	it("writes a conditioned mute override before deleting the room rule", async () => {
		const client = writableClient();

		await setRoomNotificationLevel(client, ROOM_ID, "mute");

		expect(client.addPushRule).toHaveBeenCalledWith(
			"global",
			PushRuleKind.Override,
			MUTE_RULE_ID,
			{
				actions: [PushRuleActionName.DontNotify],
				conditions: [
					{
						kind: ConditionKind.EventMatch,
						key: "room_id",
						pattern: ROOM_ID,
					},
				],
			},
		);
		expect(client.deletePushRule).toHaveBeenCalledWith(
			"global",
			PushRuleKind.RoomSpecific,
			ROOM_ID,
		);
		expect(
			requiredAt(
				vi.mocked(client.addPushRule).mock.invocationCallOrder,
				0,
				"add rule order",
			),
		).toBeLessThan(
			requiredAt(
				vi.mocked(client.deletePushRule).mock.invocationCallOrder,
				0,
				"delete rule order",
			),
		);
	});

	it("deletes both custom rules when restoring the default", async () => {
		const client = writableClient(
			rules({
				override: [
					{
						rule_id: MUTE_RULE_ID,
						actions: [PushRuleActionName.DontNotify],
					},
				],
			}),
		);

		await setRoomNotificationLevel(client, ROOM_ID, "default");

		expect(client.addPushRule).not.toHaveBeenCalled();
		expect(client.deletePushRule).toHaveBeenCalledTimes(2);
		expect(client.deletePushRule).toHaveBeenCalledWith(
			"global",
			PushRuleKind.Override,
			MUTE_RULE_ID,
		);
		expect(client.deletePushRule).toHaveBeenCalledWith(
			"global",
			PushRuleKind.RoomSpecific,
			ROOM_ID,
		);
	});

	it("ignores missing stale rules reported as 404", async () => {
		const client = writableClient(
			rules({
				override: [
					{
						rule_id: MUTE_RULE_ID,
						actions: [PushRuleActionName.DontNotify],
					},
				],
			}),
		);
		vi.mocked(client.deletePushRule).mockRejectedValue({ httpStatus: 404 });

		await expect(
			setRoomNotificationLevel(client, ROOM_ID, "default"),
		).resolves.toBeUndefined();
	});

	it("propagates add failures without starting cleanup", async () => {
		const client = writableClient();
		const failure = new Error("write failed");
		vi.mocked(client.addPushRule).mockRejectedValue(failure);

		await expect(
			setRoomNotificationLevel(client, ROOM_ID, "mute"),
		).rejects.toBe(failure);
		expect(client.deletePushRule).not.toHaveBeenCalled();
	});

	it("propagates non-404 cleanup failures", async () => {
		const client = writableClient();
		const failure = { httpStatus: 500 };
		vi.mocked(client.deletePushRule).mockRejectedValue(failure);

		await expect(
			setRoomNotificationLevel(client, ROOM_ID, "all-messages"),
		).rejects.toBe(failure);
	});
});
