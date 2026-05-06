/**
 * Per-room notification level utility.
 *
 * Maps a Discord-style four-level model onto Matrix push rules:
 *
 * | Level         | Rule kind  | Actions                              |
 * |---------------|------------|--------------------------------------|
 * | default       | (none)     | Inherits global push rules           |
 * | all-messages  | room       | notify + sound: "default"            |
 * | mentions-only | room       | dont_notify                          |
 * | mute          | override   | dont_notify (suppresses everything)  |
 */

import {
	ConditionKind,
	type MatrixClient,
	type PushRuleAction,
	PushRuleActionName,
	PushRuleKind,
	TweakName,
} from "matrix-js-sdk";

export type RoomNotificationLevel =
	| "default"
	| "all-messages"
	| "mentions-only"
	| "mute";

/** Rule ID used for mute overrides. Prefixed to avoid clashing with room IDs. */
function muteRuleId(roomId: string): string {
	return `crust.mute.${roomId}`;
}

const ALL_MESSAGES_ACTIONS: PushRuleAction[] = [
	PushRuleActionName.Notify,
	{ set_tweak: TweakName.Sound, value: "default" },
];

const DONT_NOTIFY_ACTIONS: PushRuleAction[] = [PushRuleActionName.DontNotify];

/**
 * Read the current notification level for a room from the client's
 * cached push rules.  Returns "default" if no room-specific rule exists.
 */
export function getRoomNotificationLevel(
	client: MatrixClient,
	roomId: string,
): RoomNotificationLevel {
	const rules = client.pushRules;
	if (!rules) return "default";

	// Check for mute override first (highest priority)
	const overrides = rules.global?.override;
	if (overrides) {
		const mId = muteRuleId(roomId);
		const muteRule = overrides.find(
			(r) => r.rule_id === mId && r.enabled !== false,
		);
		if (muteRule) return "mute";
	}

	// Check room-kind rules
	const roomRules = rules.global?.room;
	if (roomRules) {
		const roomRule = roomRules.find(
			(r) => r.rule_id === roomId && r.enabled !== false,
		);
		if (roomRule) {
			const hasDontNotify = roomRule.actions.some(
				(a) => a === PushRuleActionName.DontNotify,
			);
			if (hasDontNotify) return "mentions-only";

			const hasNotify = roomRule.actions.some(
				(a) => a === PushRuleActionName.Notify,
			);
			if (hasNotify) return "all-messages";
		}
	}

	return "default";
}

/**
 * Set the notification level for a room.  Writes the appropriate push
 * rules via the homeserver API.
 *
 * Throws on network failure — callers should handle errors.
 */
export async function setRoomNotificationLevel(
	client: MatrixClient,
	roomId: string,
	level: RoomNotificationLevel,
): Promise<void> {
	const current = getRoomNotificationLevel(client, roomId);
	if (current === level) return;

	// Clean up existing rules first
	await cleanupRoomRules(client, roomId, current);

	// Set new rules
	switch (level) {
		case "default":
			// No rules needed — cleanup already removed them
			break;

		case "all-messages":
			await client.addPushRule("global", PushRuleKind.RoomSpecific, roomId, {
				actions: ALL_MESSAGES_ACTIONS,
			});
			break;

		case "mentions-only":
			await client.addPushRule("global", PushRuleKind.RoomSpecific, roomId, {
				actions: DONT_NOTIFY_ACTIONS,
			});
			break;

		case "mute":
			await client.addPushRule(
				"global",
				PushRuleKind.Override,
				muteRuleId(roomId),
				{
					actions: DONT_NOTIFY_ACTIONS,
					conditions: [
						{
							kind: ConditionKind.EventMatch,
							key: "room_id",
							pattern: roomId,
						},
					],
				},
			);
			break;
	}
}

async function cleanupRoomRules(
	client: MatrixClient,
	roomId: string,
	current: RoomNotificationLevel,
): Promise<void> {
	try {
		if (current === "mute") {
			await client.deletePushRule(
				"global",
				PushRuleKind.Override,
				muteRuleId(roomId),
			);
		} else if (current === "all-messages" || current === "mentions-only") {
			await client.deletePushRule("global", PushRuleKind.RoomSpecific, roomId);
		}
	} catch (err: unknown) {
		// Rule may not exist server-side — ignore 404s during cleanup
		const status =
			err instanceof Object && "httpStatus" in err
				? (err as { httpStatus: number }).httpStatus
				: undefined;
		if (status !== 404) throw err;
	}
}
