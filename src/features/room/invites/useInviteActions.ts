import { createSignal } from "solid-js";
import { useClient } from "../../../client/client";
import { userFacingErrorMessage } from "../../../lib/errorMessage";
import { recordDmInDirectMap } from "../startDm";
import { getInviteDetails } from "./inviteDetails";

/** Which invite action is currently in flight (at most one at a time). */
export type InvitePending = "accept" | "decline" | null;

export interface InviteActions {
	accept: () => Promise<void>;
	decline: () => Promise<void>;
	pending: () => InvitePending;
	error: () => string | null;
}

/**
 * Accept/decline handlers for a pending invite, with in-flight and inline
 * error state. The invite card is its own failure surface, so errors render
 * inline (per the AGENTS.md error convention) - no toast.
 *
 * Accept joins the room, records a DM invite in `m.direct` (so the room lands
 * under Direct Messages, mirroring what `startDm` does for created DMs), and
 * optimistically flips the summary entry to "join" so every join-filtered
 * list updates before /sync. Decline leaves the room, navigates away via
 * `onDeclined`, then optimistically marks the room left (see the ordering
 * note in `decline`).
 */
export function useInviteActions(
	roomId: () => string,
	opts?: { onDeclined?: () => void },
): InviteActions {
	const {
		client,
		summaries,
		optimisticallyMarkJoined,
		optimisticallyMarkLeft,
	} = useClient();
	const [pending, setPending] = createSignal<InvitePending>(null);
	const [error, setError] = createSignal<string | null>(null);

	const accept = async (): Promise<void> => {
		if (pending()) return;
		// Snapshot before the await: the summary/room may churn mid-flight.
		const rid = roomId();
		const summary = summaries[rid];
		const room = client.getRoom(rid);
		const myUserId = client.getUserId();
		const details = room && myUserId ? getInviteDetails(room, myUserId) : null;
		setPending("accept");
		setError(null);
		try {
			await client.joinRoom(rid);
			// A DM invite must be recorded in m.direct, exactly as startDm records
			// a created DM - otherwise the room lands under "Rooms" instead of
			// "Direct Messages". Best-effort: the join already succeeded, so a
			// failed account-data write must not surface as a failed accept; the
			// optimistic isDirect below keeps the UI right until a later write
			// or /sync reconciles.
			if (details?.isDirect && details.inviterId) {
				try {
					await recordDmInDirectMap(client, details.inviterId, rid);
				} catch (err) {
					console.warn("Failed to record accepted DM invite in m.direct", err);
				}
			}
			optimisticallyMarkJoined(rid, {
				name: summary?.name?.trim() || room?.name || rid,
				avatarUrl: summary?.avatarUrl ?? null,
				isSpace: summary?.isSpace === true,
				isDirect: details?.isDirect === true,
			});
		} catch (err) {
			console.error(`Failed to accept invite to ${rid}:`, err);
			setError(userFacingErrorMessage(err, "Could not accept the invite."));
		} finally {
			setPending(null);
		}
	};

	const decline = async (): Promise<void> => {
		if (pending()) return;
		const rid = roomId();
		setPending("decline");
		setError(null);
		try {
			await client.leave(rid);
			// Navigate away BEFORE flipping the store: Layout picks the invite
			// pane over RoomPane via `membership === "invite"`, so marking the
			// room "leave" while the route still points at it would transiently
			// mount RoomPane (timeline + composer) for a room the user just
			// left. Store writes are not batched with the router update.
			opts?.onDeclined?.();
			optimisticallyMarkLeft(rid);
		} catch (err) {
			console.error(`Failed to decline invite to ${rid}:`, err);
			setError(userFacingErrorMessage(err, "Could not decline the invite."));
		} finally {
			setPending(null);
		}
	};

	return { accept, decline, pending, error };
}
