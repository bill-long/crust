import {
	type MatrixClient,
	type MatrixEvent,
	RoomStateEvent,
} from "matrix-js-sdk";
import { type Accessor, createMemo, createSignal, onCleanup } from "solid-js";
import {
	effectiveLevel,
	effectiveUsersDefault,
	type GatedKey,
	type PowerLevelContent,
} from "./powerLevelPresets";

const POWER_LEVELS_TYPE = "m.room.power_levels";
const MEMBER_TYPE = "m.room.member";

export interface RoomPermissions {
	myPowerLevel: Accessor<number>;
	usersDefault: Accessor<number>;
	/** Required power level to send a given state event type. */
	requiredPowerLevel: (type: string) => number;
	/** Required power level for a gated key (kick/ban/invite/redact/events_default/state_default). */
	requiredPowerLevelForKey: (key: GatedKey) => number;
	canSetName: Accessor<boolean>;
	canSetTopic: Accessor<boolean>;
	canSetAvatar: Accessor<boolean>;
	canSetCanonicalAlias: Accessor<boolean>;
	canSetPowerLevels: Accessor<boolean>;
	canSetJoinRules: Accessor<boolean>;
	canSetHistoryVisibility: Accessor<boolean>;
	/** Whether the user may set `m.room.guest_access`. */
	canSetGuestAccess: Accessor<boolean>;
	/** Whether the user may add/remove `m.space.child` (manage child rooms). */
	canSetSpaceChild: Accessor<boolean>;
	canInvite: Accessor<boolean>;
	canKick: Accessor<boolean>;
	canBan: Accessor<boolean>;
	canRedact: Accessor<boolean>;
	/**
	 * True iff the caller can moderate (kick) a specific target. Requires
	 * the kick power-level AND the target's current PL to be strictly
	 * less than the caller's PL (Matrix auth: cannot act on a peer).
	 * Self-moderation is not allowed.
	 */
	canKickTarget: (targetUserId: string) => boolean;
	/** Same shape as canKickTarget but gated by the ban PL. */
	canBanTarget: (targetUserId: string) => boolean;
	/**
	 * True iff the caller can change a target user's PL to `requestedPL`.
	 * Auth rules require BOTH the target's current PL and the requested
	 * new PL to be strictly less than the caller's. See the design plan
	 * for the rationale (a mod can promote to mod but not to admin).
	 */
	canChangePowerLevel: (targetUserId: string, requestedPL: number) => boolean;
}

function canSendStateEvent(
	client: MatrixClient,
	roomId: string | undefined,
	type: string,
): boolean {
	if (!roomId) return false;
	const room = client.getRoom(roomId);
	const uid = client.getUserId();
	if (!room || !uid) return false;
	try {
		return room.currentState.maySendStateEvent(type, uid);
	} catch {
		return false;
	}
}

export function useRoomPermissions(
	client: MatrixClient,
	roomId: Accessor<string | undefined>,
): RoomPermissions {
	const [tick, setTick] = createSignal(0);

	const onRoomState = (event: MatrixEvent): void => {
		if (event.getRoomId() !== roomId()) return;
		const t = event.getType();
		if (t === POWER_LEVELS_TYPE) {
			setTick((n) => n + 1);
			return;
		}
		if (t === MEMBER_TYPE && event.getStateKey() === client.getUserId()) {
			setTick((n) => n + 1);
		}
	};

	client.on(RoomStateEvent.Events, onRoomState);
	onCleanup(() => {
		client.off(RoomStateEvent.Events, onRoomState);
	});

	const plContent = createMemo<PowerLevelContent>(() => {
		tick();
		const rid = roomId();
		if (!rid) return {};
		const room = client.getRoom(rid);
		if (!room) return {};
		const ev = room.currentState.getStateEvents(POWER_LEVELS_TYPE, "");
		if (!ev) return {};
		const content = (ev as unknown as MatrixEvent).getContent?.();
		return (content as PowerLevelContent) ?? {};
	});

	const myPowerLevel = createMemo<number>(() => {
		tick();
		const rid = roomId();
		const uid = client.getUserId();
		if (!rid || !uid) return 0;
		const room = client.getRoom(rid);
		if (!room) return 0;
		const member = room.getMember(uid);
		return member?.powerLevel ?? 0;
	});

	const usersDefault = createMemo<number>(() =>
		effectiveUsersDefault(plContent()),
	);

	const requiredPowerLevel = (type: string): number => {
		const pl = plContent();
		const events = pl.events;
		const raw = events?.[type];
		if (typeof raw === "number" && Number.isFinite(raw)) return raw;
		return effectiveLevel(pl, "state_default");
	};

	const requiredPowerLevelForKey = (key: GatedKey): number =>
		effectiveLevel(plContent(), key);

	const makeStateCan = (type: string): Accessor<boolean> =>
		createMemo(() => {
			tick();
			return canSendStateEvent(client, roomId(), type);
		});

	const makeKeyCan = (key: GatedKey): Accessor<boolean> =>
		createMemo(() => myPowerLevel() >= effectiveLevel(plContent(), key));

	const targetPowerLevel = (targetUserId: string): number => {
		const pl = plContent();
		const raw = pl.users?.[targetUserId];
		if (typeof raw === "number" && Number.isFinite(raw)) return raw;
		return effectiveUsersDefault(pl);
	};

	const canModerateTarget = (
		targetUserId: string,
		keyCan: Accessor<boolean>,
	): boolean => {
		if (!keyCan()) return false;
		const uid = client.getUserId();
		if (!uid || uid === targetUserId) return false;
		return targetPowerLevel(targetUserId) < myPowerLevel();
	};

	const canChangePowerLevel = (
		targetUserId: string,
		requestedPL: number,
	): boolean => {
		if (!canSendStateEvent(client, roomId(), POWER_LEVELS_TYPE)) return false;
		const myPL = myPowerLevel();
		const targetPL = targetPowerLevel(targetUserId);
		// Matrix auth requires both the target's current PL and the
		// requested new PL to be strictly less than the caller's PL.
		return targetPL < myPL && requestedPL < myPL;
	};

	const canKickMemo = makeKeyCan("kick");
	const canBanMemo = makeKeyCan("ban");

	return {
		myPowerLevel,
		usersDefault,
		requiredPowerLevel,
		requiredPowerLevelForKey,
		canSetName: makeStateCan("m.room.name"),
		canSetTopic: makeStateCan("m.room.topic"),
		canSetAvatar: makeStateCan("m.room.avatar"),
		canSetCanonicalAlias: makeStateCan("m.room.canonical_alias"),
		canSetPowerLevels: makeStateCan(POWER_LEVELS_TYPE),
		canSetJoinRules: makeStateCan("m.room.join_rules"),
		canSetHistoryVisibility: makeStateCan("m.room.history_visibility"),
		canSetGuestAccess: makeStateCan("m.room.guest_access"),
		canSetSpaceChild: makeStateCan("m.space.child"),
		canInvite: makeKeyCan("invite"),
		canKick: canKickMemo,
		canBan: canBanMemo,
		canRedact: makeKeyCan("redact"),
		canKickTarget: (targetUserId) =>
			canModerateTarget(targetUserId, canKickMemo),
		canBanTarget: (targetUserId) => canModerateTarget(targetUserId, canBanMemo),
		canChangePowerLevel,
	};
}
