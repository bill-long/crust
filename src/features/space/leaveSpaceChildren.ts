import type { MatrixClient } from "matrix-js-sdk";

/** Minimal child-room shape needed to leave it and name it in feedback. */
export interface LeavableChild {
	roomId: string;
	name: string;
}

export interface ChildLeaveOutcome {
	/** Room IDs whose `client.leave` resolved successfully. */
	leftRoomIds: string[];
	/** Display names (or room IDs) of children whose leave rejected. */
	failedNames: string[];
	/** True when the caller's current routed room was successfully left. */
	routeRoomLeft: boolean;
}

/**
 * Leave a batch of child rooms best-effort. Uses `Promise.allSettled` so a
 * single failure doesn't abort the batch, and reports which rooms were left so
 * the caller can apply navigation / aggregate feedback.
 *
 * `onRoomLeft` is invoked for each room **immediately** after its own
 * `client.leave` resolves — before the rest of the batch settles. The caller
 * uses it to apply per-room side effects (optimistic mark-left, tearing down an
 * active call hosted in that room) the moment that room is actually left, so a
 * call controller never outlives its room during the batch and a room whose
 * leave *failed* is never affected. Throwing inside `onRoomLeft` does not mark
 * the leave as failed.
 */
export async function leaveChildRooms(
	client: Pick<MatrixClient, "leave">,
	children: readonly LeavableChild[],
	opts: { currentRoomId?: string; onRoomLeft?: (roomId: string) => void },
): Promise<ChildLeaveOutcome> {
	const results = await Promise.allSettled(
		children.map(async (c) => {
			await client.leave(c.roomId);
			try {
				opts.onRoomLeft?.(c.roomId);
			} catch (err) {
				console.error("onRoomLeft callback failed:", c.roomId, err);
			}
		}),
	);

	const leftRoomIds: string[] = [];
	const failedNames: string[] = [];
	let routeRoomLeft = false;

	results.forEach((res, i) => {
		const { roomId, name } = children[i];
		if (res.status === "fulfilled") {
			leftRoomIds.push(roomId);
			if (roomId === opts.currentRoomId) routeRoomLeft = true;
		} else {
			console.error("Failed to leave child room:", roomId, res.reason);
			failedNames.push(name.trim() || roomId);
		}
	});

	return { leftRoomIds, failedNames, routeRoomLeft };
}

/**
 * Aggregate feedback shown when a space was left but some child rooms could
 * not be. `leftCount` counts successfully-left children (not the space itself).
 */
export function buildPartialLeaveMessage(
	leftCount: number,
	failedNames: readonly string[],
): string {
	return `Left the space and ${leftCount} room${
		leftCount === 1 ? "" : "s"
	}, but ${failedNames.length} could not be left (${failedNames.join(
		", ",
	)}). They remain joined — leave them individually.`;
}
