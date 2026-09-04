import {
	type MatrixClient,
	type MatrixEvent,
	type Room,
	RoomEvent,
	RoomStateEvent,
} from "matrix-js-sdk";
import { type Accessor, createMemo, createSignal, onCleanup } from "solid-js";
import { useClientIfProvided } from "../../../client/client";
import {
	canSendStateEvent,
	readMyMembership,
} from "../../../client/stateEventPermission";
import { useRoomAvailableTick } from "../useRoomAvailableTick";
import {
	effectiveLevel,
	effectiveUsersDefault,
	type GatedKey,
	type PowerLevelContent,
} from "./powerLevelPresets";

const POWER_LEVELS_TYPE = "m.room.power_levels";
const MEMBER_TYPE = "m.room.member";

/**
 * Reactive `readMyMembership`: tracks the store, `RoomEvent.MyMembership`
 * (for the SDK fallback) and the room arriving after a deep link. For a
 * consumer that already has a `useRoomPermissions` instance, read
 * `perms.isJoined` instead of mounting this a second time.
 */
export function useMyMembership(
	client: MatrixClient,
	roomId: Accessor<string | undefined>,
): Accessor<string | undefined> {
	const summaries = useClientIfProvided()?.summaries;
	const [tick, setTick] = createSignal(0);
	const onMyMembership = (room: Room): void => {
		if (room.roomId === roomId()) setTick((n) => n + 1);
	};
	client.on(RoomEvent.MyMembership, onMyMembership);
	onCleanup(() => {
		client.off(RoomEvent.MyMembership, onMyMembership);
	});
	const roomAvailableTick = useRoomAvailableTick(client, roomId);
	return createMemo(() => {
		tick();
		roomAvailableTick();
		return readMyMembership(client, roomId(), summaries);
	});
}

export interface RoomPermissions {
	/**
	 * Whether the caller is currently joined. Every write gate below is
	 * ANDed with this: power levels survive leaving (`RoomMember.powerLevel`
	 * keeps an ex-admin at 100 and `maySendStateEvent` reads only the PL
	 * event), so without it a left/banned room offers editors whose saves
	 * fail with M_FORBIDDEN (#527). Read it directly for a write that has
	 * no power-level rule (directory listing) or to hide "no permission"
	 * copy that would misstate the reason next to the overlay's notice.
	 */
	isJoined: Accessor<boolean>;
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
	/**
	 * A target user's effective power level (their `users` entry, or the
	 * room's users_default). The SAME source the can* gates read, so a
	 * role label derived from it can never disagree with the gates.
	 */
	targetPowerLevel: (targetUserId: string) => number;
}

export function useRoomPermissions(
	client: MatrixClient,
	roomId: Accessor<string | undefined>,
): RoomPermissions {
	const summaries = useClientIfProvided()?.summaries;
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

	// Recovery for a Room that isn't in the store yet at mount (deep-link
	// before initial sync) - without it every permission memo latches
	// false and settings render read-only until an unrelated PL change.
	const roomAvailableTick = useRoomAvailableTick(client, roomId);

	// See RoomPermissions.isJoined. Read gates (`myPowerLevel`,
	// `targetPowerLevel`, `requiredPowerLevel*`) stay unfiltered: they
	// describe the room, not what the caller may do to it.
	const myMembership = useMyMembership(client, roomId);
	const isJoined = createMemo((): boolean => myMembership() === "join");

	const plContent = createMemo<PowerLevelContent>(() => {
		tick();
		roomAvailableTick();
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
		roomAvailableTick();
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
			roomAvailableTick();
			// Subscribe to RoomEvent.MyMembership for the SDK fallback. The shared
			// helper repeats the membership check so every non-reactive caller gets
			// the same safety rule too.
			if (!isJoined()) return false;
			return canSendStateEvent(client, roomId(), type, summaries);
		});

	const makeKeyCan = (key: GatedKey): Accessor<boolean> =>
		createMemo(
			() => isJoined() && myPowerLevel() >= effectiveLevel(plContent(), key),
		);

	const targetPowerLevel = (targetUserId: string): number => {
		// Read the PL content FIRST so reactive callers subscribe to PL
		// changes regardless of which branch answers.
		const pl = plContent();
		const raw = pl.users?.[targetUserId];
		if (typeof raw === "number" && Number.isFinite(raw)) return raw;
		// No users entry: prefer the SDK-computed member power before the
		// users_default fallback - in newer room versions the creator is
		// privileged WITHOUT a users entry, and the SDK models that in
		// RoomMember.powerLevel (so the creator reads as admin here and,
		// via canModerateTarget, can't be kicked by a mere admin - which
		// matches server auth).
		const rid = roomId();
		const member = rid ? client.getRoom(rid)?.getMember(targetUserId) : null;
		if (member && typeof member.powerLevel === "number") {
			return member.powerLevel;
		}
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

	const canSetPowerLevelsMemo = makeStateCan(POWER_LEVELS_TYPE);

	const canChangePowerLevel = (
		targetUserId: string,
		requestedPL: number,
	): boolean => {
		if (!canSetPowerLevelsMemo()) return false;
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
		canSetPowerLevels: canSetPowerLevelsMemo,
		canSetJoinRules: makeStateCan("m.room.join_rules"),
		canSetHistoryVisibility: makeStateCan("m.room.history_visibility"),
		canSetGuestAccess: makeStateCan("m.room.guest_access"),
		canSetSpaceChild: makeStateCan("m.space.child"),
		isJoined,
		canInvite: makeKeyCan("invite"),
		canKick: canKickMemo,
		canBan: canBanMemo,
		canRedact: makeKeyCan("redact"),
		canKickTarget: (targetUserId) =>
			canModerateTarget(targetUserId, canKickMemo),
		canBanTarget: (targetUserId) => canModerateTarget(targetUserId, canBanMemo),
		canChangePowerLevel,
		targetPowerLevel,
	};
}
