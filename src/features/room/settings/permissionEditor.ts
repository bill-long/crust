import { validateMatrixUserId } from "../../../lib/inviteValidation";
import {
	effectiveLevel,
	type PowerLevelContent,
	SPEC_DEFAULTS,
} from "./powerLevelPresets";

export type PermissionSection =
	| "defaults"
	| "events"
	| "users"
	| "notifications";
export interface PermissionTarget {
	section: PermissionSection;
	key: string;
}
export interface PermissionAction extends PermissionTarget {
	label: string;
	state?: boolean;
}

// One catalogue owns labels and inheritance for the named permission controls.
export const PERMISSION_ACTIONS: PermissionAction[] = [
	{
		section: "defaults",
		key: "events_default",
		label: "Default message permissions",
	},
	{ section: "defaults", key: "state_default", label: "Change room settings" },
	{ section: "defaults", key: "users_default", label: "Default member level" },
	{ section: "defaults", key: "invite", label: "Invite users" },
	{ section: "defaults", key: "kick", label: "Kick users" },
	{ section: "defaults", key: "ban", label: "Ban users" },
	{ section: "defaults", key: "redact", label: "Delete others' messages" },
	{ section: "notifications", key: "room", label: "Notify everyone (@room)" },
	{
		section: "events",
		key: "m.room.message",
		label: "Send messages",
		state: false,
	},
	{
		section: "events",
		key: "m.room.encrypted",
		label: "Send encrypted messages",
		state: false,
	},
	{
		section: "events",
		key: "m.room.redaction",
		label: "Send message deletions",
		state: false,
	},
	{
		section: "events",
		key: "org.matrix.msc3401.call.member",
		label: "Start / join calls",
		state: true,
	},
	{
		section: "events",
		key: "org.matrix.msc4143.rtc.member",
		label: "Join Matrix 2.0 calls",
		state: false,
	},
	{
		section: "events",
		key: "m.room.pinned_events",
		label: "Pin messages",
		state: true,
	},
	{
		section: "events",
		key: "m.room.name",
		label: "Change room name",
		state: true,
	},
	{
		section: "events",
		key: "m.room.topic",
		label: "Change room topic",
		state: true,
	},
	{
		section: "events",
		key: "m.room.avatar",
		label: "Change room avatar",
		state: true,
	},
	{
		section: "events",
		key: "m.room.canonical_alias",
		label: "Change room address",
		state: true,
	},
	{
		section: "events",
		key: "m.room.join_rules",
		label: "Change joining rules",
		state: true,
	},
	{
		section: "events",
		key: "m.room.history_visibility",
		label: "Change history visibility",
		state: true,
	},
	{
		section: "events",
		key: "m.room.guest_access",
		label: "Change guest access",
		state: true,
	},
	{
		section: "events",
		key: "m.room.power_levels",
		label: "Manage permissions",
		state: true,
	},
	{
		section: "events",
		key: "m.space.child",
		label: "Manage space rooms",
		state: true,
	},
	{
		section: "events",
		key: "m.space.parent",
		label: "Manage parent spaces",
		state: true,
	},
	{
		section: "events",
		key: "m.reaction",
		label: "Send reactions",
		state: false,
	},
	{ section: "events", key: "m.sticker", label: "Send stickers", state: false },
	{
		section: "events",
		key: "im.vector.modular.widgets",
		label: "Manage widgets in other clients",
		state: true,
	},
];

export function explicitPermission(
	content: PowerLevelContent,
	target: PermissionTarget,
): number | undefined {
	const value =
		target.section === "defaults"
			? content[target.key]
			: content[target.section]?.[target.key];
	return typeof value === "number" ? value : undefined;
}

export function inheritedPermission(
	content: PowerLevelContent,
	target: PermissionTarget,
): number | undefined {
	if (target.section === "defaults")
		return target.key === "users_default"
			? 0
			: SPEC_DEFAULTS[target.key as keyof typeof SPEC_DEFAULTS];
	if (target.section === "users") return content.users_default ?? 0;
	if (target.section === "notifications") return 50;
	const action = PERMISSION_ACTIONS.find(
		(a) => a.section === target.section && a.key === target.key,
	);
	// Unknown event types may be either state or message events; don't guess.
	return action
		? effectiveLevel(content, action.state ? "state_default" : "events_default")
		: undefined;
}

export function permissionValue(
	content: PowerLevelContent,
	target: PermissionTarget,
): number | undefined {
	return (
		explicitPermission(content, target) ?? inheritedPermission(content, target)
	);
}

export function withPermission(
	content: PowerLevelContent,
	target: PermissionTarget,
	level: number | null,
): PowerLevelContent {
	const next = { ...content };
	if (target.section === "defaults") {
		if (level === null) delete next[target.key];
		else next[target.key] = level;
	} else {
		const map = { ...content[target.section] };
		if (level === null) delete map[target.key];
		else
			Object.defineProperty(map, target.key, {
				value: level,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		next[target.section] = map;
	}
	return next;
}

export function parsePermissionLevel(value: string): number | null {
	if (!/^-?\d+$/.test(value.trim())) return null;
	const level = Number(value);
	return Number.isSafeInteger(level) ? level : null;
}

export function permissionEditError(
	content: PowerLevelContent,
	target: PermissionTarget,
	level: number | null,
	actor: string,
	actorLevel: number,
	targetIsCreator: boolean,
): string | null {
	if (level !== null && !Number.isSafeInteger(level))
		return "Enter a whole-number power level.";
	// Matrix authorization compares properties actually added/changed/removed,
	// not the effective permission inherited when a property is absent.
	// https://spec.matrix.org/v1.16/rooms/v12/#authorization-rules (rule 10)
	const current = explicitPermission(content, target);
	const next = level;
	if (target.section === "users") {
		const userId = validateMatrixUserId(target.key);
		if (!userId.ok || userId.userId !== target.key)
			return "Enter a complete Matrix user ID.";
		if (targetIsCreator)
			return "Room creators have permanent privileges and cannot be assigned a level.";
		if (target.key !== actor && current !== undefined && current >= actorLevel)
			return "You cannot change a member with an equal or higher level.";
	} else if (current !== undefined && current > actorLevel)
		return "This permission is above your level.";
	if (next !== undefined && next !== null && next > actorLevel)
		return "You cannot assign a level above your own.";
	return null;
}
