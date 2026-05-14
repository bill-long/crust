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

	// Add the new rule first so notifications never fall back to default
	// during the transition (addPushRule replaces same-ID rules atomically).
	switch (level) {
		case "default":
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

	// Then clean up rules from the previous level that don't belong
	await cleanupStaleRules(client, roomId, level);
}

async function cleanupStaleRules(
	client: MatrixClient,
	roomId: string,
	newLevel: RoomNotificationLevel,
): Promise<void> {
	const deletions: Promise<unknown>[] = [];
	if (newLevel !== "mute") {
		deletions.push(
			client
				.deletePushRule("global", PushRuleKind.Override, muteRuleId(roomId))
				.catch(ignore404),
		);
	}
	if (newLevel !== "all-messages" && newLevel !== "mentions-only") {
		deletions.push(
			client
				.deletePushRule("global", PushRuleKind.RoomSpecific, roomId)
				.catch(ignore404),
		);
	}
	await Promise.all(deletions);
}

function ignore404(err: unknown): void {
	const status =
		err instanceof Object && "httpStatus" in err
			? (err as { httpStatus: number }).httpStatus
			: undefined;
	if (status !== 404) throw err;
}
