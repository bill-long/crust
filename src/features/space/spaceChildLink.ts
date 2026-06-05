import { EventType, type MatrixClient } from "matrix-js-sdk";

export interface SpaceLinkResult {
	/** Whether the parent-side `m.space.child` event was sent successfully. */
	childOk: boolean;
	/** Rejection reason when the `m.space.child` send failed. */
	childError?: unknown;
	/**
	 * Outcome of the child-side `m.space.parent` send:
	 *  - "ok": sent successfully.
	 *  - "failed": attempted but rejected (best-effort; never fatal).
	 *  - "skipped": not attempted (user lacks `m.space.parent` permission in
	 *    the child room — only checked when `checkParentPermission` is set).
	 */
	parent: "ok" | "failed" | "skipped";
	/** Rejection reason when the `m.space.parent` send failed. */
	parentError?: unknown;
}

type LinkClient = Pick<
	MatrixClient,
	"sendStateEvent" | "getDomain" | "getUserId" | "getRoom"
>;

/**
 * Establish the bidirectional space relationship between a parent space and a
 * child room (per MSC1772):
 *  - `m.space.child` on the **parent** space, pointing at the child.
 *  - `m.space.parent` on the **child** room, pointing at the parent, so the
 *    relationship is discoverable from the child (e.g. when a client loads the
 *    child first via a direct link/invite). Content: `{ via, canonical: true }`.
 *
 * The two events are written **sequentially**: `m.space.child` first, then
 * `m.space.parent` only if the child write succeeded. This guarantees we never
 * leave an orphaned one-sided `m.space.parent` (a child claiming a parent the
 * space doesn't list — which clients distrust anyway). The `m.space.parent`
 * write is best-effort and never makes the helper reject; the caller decides
 * how to treat a failed `m.space.child` write via `childOk`.
 *
 * `checkParentPermission` gates the `m.space.parent` write on
 * `maySendStateEvent` in the child room. Set it for flows that add an
 * *existing* room (the user may be a plain member there). Leave it unset for
 * the create-in-space flow: the creator always has permission, and the freshly
 * created room may not yet be in the SDK's room list to check against.
 */
export async function linkRoomToSpace(
	client: LinkClient,
	spaceId: string,
	childRoomId: string,
	opts?: { checkParentPermission?: boolean },
): Promise<SpaceLinkResult> {
	const domain = client.getDomain();
	const via = domain ? [domain] : [];
	const sendParent = opts?.checkParentPermission
		? canSendSpaceParent(client, childRoomId)
		: true;
	return writeLinkSequential(
		client,
		spaceId,
		childRoomId,
		{ via, suggested: false },
		{ via, canonical: true },
		sendParent,
	);
}

/**
 * Tear down the bidirectional space relationship: remove the `m.space.child`
 * on the parent space AND (permitting) the `m.space.parent` on the child room,
 * keeping the two sides symmetric with {@link linkRoomToSpace}. Both removals
 * send empty content. Sequential: the child-side removal is only attempted if
 * the `m.space.child` removal succeeded, so a failed remove leaves BOTH sides
 * intact (consistent with the optimistic UI rollback).
 *
 * `checkParentPermission` gates the `m.space.parent` removal on the user's
 * permission in the child room.
 */
export async function unlinkRoomFromSpace(
	client: LinkClient,
	spaceId: string,
	childRoomId: string,
	opts?: { checkParentPermission?: boolean },
): Promise<SpaceLinkResult> {
	const removeParent = opts?.checkParentPermission
		? canSendSpaceParent(client, childRoomId)
		: true;
	// Empty content removes each relationship.
	return writeLinkSequential(
		client,
		spaceId,
		childRoomId,
		{},
		{},
		removeParent,
	);
}

/**
 * Write (or clear, when contents are empty) both sides of a space relationship
 * sequentially: `m.space.child` on the space first, then — only if that
 * succeeded and `sendParent` is true — `m.space.parent` on the child. The
 * parent write is best-effort and never flips `childOk`.
 */
async function writeLinkSequential(
	client: LinkClient,
	spaceId: string,
	childRoomId: string,
	childContent: Record<string, unknown>,
	parentContent: Record<string, unknown>,
	sendParent: boolean,
): Promise<SpaceLinkResult> {
	try {
		await client.sendStateEvent(
			spaceId,
			EventType.SpaceChild,
			childContent,
			childRoomId,
		);
	} catch (childError) {
		console.error(
			"Failed to write m.space.child:",
			spaceId,
			childRoomId,
			childError,
		);
		return { childOk: false, childError, parent: "skipped" };
	}
	if (!sendParent) return { childOk: true, parent: "skipped" };
	try {
		await client.sendStateEvent(
			childRoomId,
			EventType.SpaceParent,
			parentContent,
			spaceId,
		);
		return { childOk: true, parent: "ok" };
	} catch (parentError) {
		console.error(
			"Failed to write m.space.parent:",
			childRoomId,
			spaceId,
			parentError,
		);
		return { childOk: true, parent: "failed", parentError };
	}
}

/**
 * Whether the current user may send `m.space.parent` in `childRoomId`. Returns
 * false when the room isn't known locally, there's no user id, or the SDK
 * permission check throws (treated as "cannot", like other call sites).
 */
function canSendSpaceParent(client: LinkClient, childRoomId: string): boolean {
	const uid = client.getUserId();
	const room = client.getRoom(childRoomId);
	if (!uid || !room) return false;
	try {
		return room.currentState.maySendStateEvent(EventType.SpaceParent, uid);
	} catch {
		return false;
	}
}
