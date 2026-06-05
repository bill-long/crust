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
	/** True when the active-call room was successfully left. */
	callRoomLeft: boolean;
}

/**
 * Leave a batch of child rooms best-effort. Uses `Promise.allSettled` so a
 * single failure doesn't abort the batch, and reports which rooms were left so
 * the caller can apply optimistic updates / call teardown / navigation only for
 * the rooms that were actually left.
 *
 * `currentRoomId` and `activeCallRoomId` are reported back as `routeRoomLeft` /
 * `callRoomLeft` only when their leave succeeded — the caller must NOT tear down
 * the active call for a room whose leave rejected (the user is still in it).
 */
export async function leaveChildRooms(
	client: Pick<MatrixClient, "leave">,
	children: readonly LeavableChild[],
	opts: { currentRoomId?: string; activeCallRoomId: string | null },
): Promise<ChildLeaveOutcome> {
	const results = await Promise.allSettled(
		children.map((c) => client.leave(c.roomId)),
	);

	const leftRoomIds: string[] = [];
	const failedNames: string[] = [];
	let routeRoomLeft = false;
	let callRoomLeft = false;

	results.forEach((res, i) => {
		const { roomId, name } = children[i];
		if (res.status === "fulfilled") {
			leftRoomIds.push(roomId);
			if (roomId === opts.currentRoomId) routeRoomLeft = true;
			if (roomId === opts.activeCallRoomId) callRoomLeft = true;
		} else {
			console.error("Failed to leave child room:", roomId, res.reason);
			failedNames.push(name.trim() || roomId);
		}
	});

	return { leftRoomIds, failedNames, routeRoomLeft, callRoomLeft };
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
