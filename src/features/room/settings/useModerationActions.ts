import { EventType, type MatrixClient } from "matrix-js-sdk";
import { type Accessor, createSignal } from "solid-js";
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
): ModerationActions {
	const perms = useRoomPermissions(client, roomId);
	const plContent = useRoomStateContent<PowerLevelContent>(
		client,
		roomId,
		"m.room.power_levels",
	);

	const [actionError, setActionError] = createSignal<string | null>(null);
	const [pendingAction, setPendingAction] = createSignal<MemberAction | null>(
		null,
	);

	// Serialize PL writes so rapid consecutive promote/demote actions
	// can't race against each other. The chain not only awaits prior
	// sends but also threads a local "pending PL" snapshot so write N
	// merges against write N-1's changes (the server echo may not have
	// arrived by the time write N reads `plContent()`).
	let plWriteChain: Promise<void> = Promise.resolve();
	let pendingPL: PowerLevelContent | null = null;
	let plWriteSeq = 0;
	const writePowerLevel = (
		userId: string,
		level: number | null,
	): Promise<void> => {
		const mySeq = ++plWriteSeq;
		const run = plWriteChain.then(async () => {
			const base = pendingPL ?? plContent();
			const next = withUserLevel(base, userId, level);
			pendingPL = next;
			try {
				await client.sendStateEvent(
					roomId(),
					EventType.RoomPowerLevels,
					next as unknown as Record<string, unknown>,
					"",
				);
			} finally {
				// Drop the overlay once the most-recent write settles
				// so a later burst rebases on the freshest server snapshot.
				if (mySeq === plWriteSeq) pendingPL = null;
			}
		});
		// Keep the chain alive on failure so one bad write doesn't
		// permanently break serialization.
		plWriteChain = run.catch(() => {});
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
			setActionError(e instanceof Error ? e.message : "Action failed.");
		}
	};

	// Kick/Ban are invoked from inside ConfirmDialog.onConfirm — let the
	// promise reject so the dialog catches and renders the error inline
	// instead of closing first and surfacing the failure elsewhere.
	const performKickOrBan = async (action: MemberAction): Promise<void> => {
		if (action.kind === "kick") {
			await client.kick(roomId(), action.userId);
		} else if (action.kind === "ban") {
			await client.ban(roomId(), action.userId);
		}
	};

	const requestAction = (action: MemberAction): void => {
		if (action.kind === "kick" || action.kind === "ban") {
			setPendingAction(action);
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
		performKickOrBan,
		canPromoteMod,
		canPromoteAdmin,
		canDemote,
	};
}
