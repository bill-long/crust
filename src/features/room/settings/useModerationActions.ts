import { EventType, type MatrixClient } from "matrix-js-sdk";
import { type Accessor, createSignal } from "solid-js";
import { userFacingErrorMessage } from "../../../lib/errorMessage";
import {
	levelForDemote,
	type PowerLevelContent,
	withUserLevel,
} from "./powerLevelPresets";
import { type RoomPermissions, useRoomPermissions } from "./useRoomPermissions";
import { useRoomStateContent } from "./useRoomStateContent";

export interface MemberAction {
	kind: "promote-mod" | "promote-admin" | "demote" | "kick" | "ban";
	userId: string;
	displayName: string;
}

function currentPowerLevels(
	client: MatrixClient,
	roomId: string,
): PowerLevelContent | null {
	const event = client
		.getRoom(roomId)
		?.currentState.getStateEvents(EventType.RoomPowerLevels, "");
	if (!event || Array.isArray(event)) return null;
	const content = event.getContent?.();
	if (!content || typeof content !== "object" || Array.isArray(content)) {
		return null;
	}
	return content as PowerLevelContent;
}

/**
 * Run a parked kick/ban. Standalone (not hook state) so a caller whose
 * confirm dialog outlives the component that parked the action - the
 * profile card host - can execute it with the room captured at park
 * time. Rejects on failure so ConfirmDialog renders the error inline.
 */
export async function performKickOrBan(
	client: MatrixClient,
	roomId: string,
	action: MemberAction,
): Promise<void> {
	if (action.kind === "kick") {
		await client.kick(roomId, action.userId);
	} else if (action.kind === "ban") {
		await client.ban(roomId, action.userId);
	} else {
		// Fail fast: silently closing the confirm dialog without acting
		// would mask a routing bug (only kick/ban ever park for confirm).
		throw new Error(`Not a kick/ban action: ${action.kind}`);
	}
}

export interface ModerationActions {
	perms: RoomPermissions;
	plContent: Accessor<PowerLevelContent | null>;
	/** Inline error from the last promote/demote attempt (kick/ban errors
	 *  surface inside their ConfirmDialog instead). */
	actionError: Accessor<string | null>;
	/** Kick/Ban action awaiting its ConfirmDialog, null when none. */
	pendingAction: Accessor<MemberAction | null>;
	setPendingAction: (action: MemberAction | null) => void;
	/** Route an action: kick/ban park in pendingAction for the caller's
	 *  ConfirmDialog; power-level changes run immediately. */
	requestAction: (action: MemberAction) => void;
	/** Run the parked kick/ban. Rejects on failure so ConfirmDialog can
	 *  render the error inline instead of closing first. */
	performKickOrBan: (action: MemberAction) => Promise<void>;
	canPromoteMod: (userId: string) => boolean;
	canPromoteAdmin: (userId: string) => boolean;
	canDemote: (userId: string, currentPowerLevel: number) => boolean;
}

interface PendingKickBan {
	action: MemberAction;
	roomId: string;
}

/**
 * Room-member moderation flow shared by the settings Members tab and the
 * profile card: permission-gated promote/demote power-level writes
 * (serialized so rapid actions can't race), and the kick/ban
 * confirm-then-perform handshake. The caller renders the ConfirmDialog
 * and any error surfaces; this hook owns the state and the writes.
 */
export function useModerationActions(
	client: MatrixClient,
	roomId: Accessor<string>,
	options?: {
		/**
		 * Override where a kick/ban parks awaiting confirmation. The
		 * default parks in this hook's own pendingAction (the Members
		 * tab renders its KickBanConfirm from it); the profile card
		 * parks at its host instead, whose dialog outlives the
		 * popover-scoped hook. Keeping the "kick/ban park, everything
		 * else runs" routing HERE means it exists exactly once.
		 */
		parkKickBan?: (action: MemberAction) => void;
	},
): ModerationActions {
	const perms = useRoomPermissions(client, roomId);
	const plContent = useRoomStateContent<PowerLevelContent>(
		client,
		roomId,
		"m.room.power_levels",
	);

	const [actionError, setActionError] = createSignal<string | null>(null);
	const [pendingKickBan, setPendingKickBan] =
		createSignal<PendingKickBan | null>(null);
	const pendingAction = (): MemberAction | null =>
		pendingKickBan()?.action ?? null;
	const setPendingAction = (action: MemberAction | null): void => {
		setPendingKickBan(action ? { action, roomId: roomId() } : null);
	};
	const confirmationPerms = useRoomPermissions(
		client,
		() => pendingKickBan()?.roomId ?? roomId(),
	);

	// Serialize PL writes so rapid consecutive promote/demote actions
	// can't race against each other. The chain not only awaits prior
	// sends but also threads a local "pending PL" snapshot so write N
	// merges against write N-1's changes (the server echo may not have
	// arrived by the time write N reads `plContent()`).
	const plWriteChains = new Map<string, Promise<void>>();
	const pendingPLByRoom = new Map<string, PowerLevelContent | null>();
	const plWriteSeqByRoom = new Map<string, number>();
	const writePowerLevel = (
		userId: string,
		level: number | null,
	): Promise<void> => {
		// The write runs in a later microtask after the prior queue entry. Capture
		// its destination now so switching the settings overlay to another room
		// cannot redirect an already-requested action.
		const targetRoomId = roomId();
		const mySeq = (plWriteSeqByRoom.get(targetRoomId) ?? 0) + 1;
		plWriteSeqByRoom.set(targetRoomId, mySeq);
		const previous = plWriteChains.get(targetRoomId) ?? Promise.resolve();
		const run = previous.then(async () => {
			const base = pendingPLByRoom.has(targetRoomId)
				? (pendingPLByRoom.get(targetRoomId) ?? null)
				: currentPowerLevels(client, targetRoomId);
			const next = withUserLevel(base, userId, level);
			pendingPLByRoom.set(targetRoomId, next);
			try {
				await client.sendStateEvent(
					targetRoomId,
					EventType.RoomPowerLevels,
					next as unknown as Record<string, unknown>,
					"",
				);
			} catch (error) {
				// A queued successor has not started yet (the chain is serialized), so
				// this is still the active overlay. Restore the base that preceded only
				// this rejected mutation, preserving earlier successful queued writes.
				if (pendingPLByRoom.get(targetRoomId) === next) {
					pendingPLByRoom.set(targetRoomId, base);
				}
				throw error;
			} finally {
				// Drop the overlay once the most-recent write settles
				// so a later burst rebases on the freshest server snapshot.
				if (mySeq === plWriteSeqByRoom.get(targetRoomId)) {
					pendingPLByRoom.delete(targetRoomId);
					plWriteSeqByRoom.delete(targetRoomId);
				}
			}
		});
		// Keep this room's chain alive on failure so one bad write doesn't
		// permanently break serialization. Other rooms never wait behind it.
		const chain = run.catch(() => {});
		plWriteChains.set(targetRoomId, chain);
		void chain.finally(() => {
			if (plWriteChains.get(targetRoomId) === chain) {
				plWriteChains.delete(targetRoomId);
			}
		});
		return run;
	};

	const performAction = async (action: MemberAction): Promise<void> => {
		setActionError(null);
		try {
			switch (action.kind) {
				case "promote-mod":
					if (!perms.canChangePowerLevel(action.userId, 50)) {
						setActionError(
							perms.canSetPowerLevels()
								? "You can't change this member's power level."
								: "You don't have permission to change power levels.",
						);
						return;
					}
					await writePowerLevel(action.userId, 50);
					break;
				case "promote-admin":
					if (!perms.canChangePowerLevel(action.userId, 100)) {
						setActionError(
							perms.canSetPowerLevels()
								? "You can't change this member's power level."
								: "You don't have permission to change power levels.",
						);
						return;
					}
					await writePowerLevel(action.userId, 100);
					break;
				case "demote": {
					const demote = levelForDemote(plContent());
					if (!perms.canChangePowerLevel(action.userId, demote.level ?? 0)) {
						setActionError(
							perms.canSetPowerLevels()
								? "You can't change this member's power level."
								: "You don't have permission to change power levels.",
						);
						return;
					}
					await writePowerLevel(action.userId, demote.level);
					break;
				}
			}
		} catch (e) {
			// Every queued mutation is independent. Keep a failure visible even if a
			// later queued write succeeds, since the failed mutation was rolled back.
			setActionError(userFacingErrorMessage(e, "Action failed."));
		}
	};

	// Kick/Ban are invoked from inside ConfirmDialog.onConfirm - let the
	// promise reject so the dialog catches and renders the error inline
	// instead of closing first and surfacing the failure elsewhere.
	const performKickOrBanAction = (action: MemberAction): Promise<void> => {
		const pending = pendingKickBan();
		if (
			pending &&
			(pending.action.kind !== action.kind ||
				pending.action.userId !== action.userId)
		) {
			return Promise.reject(
				new Error("This moderation action is no longer pending."),
			);
		}
		const targetRoomId = pending?.roomId ?? roomId();
		// Re-validate at confirm time, like promote/demote do in
		// performAction: the parked dialog outlives the row menu that gated
		// it, and the caller may have left, been kicked or been demoted in
		// between. A rejection renders inline; closing the dialog instead
		// would swallow a request already in flight.
		const allowed =
			action.kind === "kick"
				? confirmationPerms.canKickTarget(action.userId)
				: action.kind === "ban"
					? confirmationPerms.canBanTarget(action.userId)
					: true;
		if (!allowed) {
			return Promise.reject(
				new Error(`You can no longer ${action.kind} ${action.displayName}.`),
			);
		}
		return performKickOrBan(client, targetRoomId, action);
	};

	const requestAction = (action: MemberAction): void => {
		if (action.kind === "kick" || action.kind === "ban") {
			(options?.parkKickBan ?? setPendingAction)(action);
			return;
		}
		void performAction(action);
	};

	const canPromoteMod = (userId: string): boolean =>
		perms.canChangePowerLevel(userId, 50);
	const canPromoteAdmin = (userId: string): boolean =>
		perms.canChangePowerLevel(userId, 100);
	const canDemote = (userId: string, currentPowerLevel: number): boolean => {
		const level = levelForDemote(plContent()).level ?? 0;
		return currentPowerLevel > 0 && perms.canChangePowerLevel(userId, level);
	};

	return {
		perms,
		plContent,
		actionError,
		pendingAction,
		setPendingAction,
		requestAction,
		performKickOrBan: performKickOrBanAction,
		canPromoteMod,
		canPromoteAdmin,
		canDemote,
	};
}
