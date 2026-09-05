import type { MatrixClient, Room } from "matrix-js-sdk";
import { reportError } from "../lib/reportError";
import { reorderLexicographically } from "../lib/stringOrderField";
import { enqueueOwnerKeyedWrite } from "../lib/writeQueue";
import type { RoomSummary, SummariesStore } from "./summaries";

/**
 * Per-room account data carrying the user's manual ordering of top-level
 * spaces (MSC3230, `im.vector.web.space_order` as shipped by Element).
 * Content is `{ order: string }`; ordered spaces sort before unordered
 * ones, lexicographically by code point.
 */
export const SPACE_ORDER_TYPE = "im.vector.web.space_order";

/**
 * MSC1772 constraints Element also enforces: printable ASCII, <= 50 chars.
 * The empty string is VALID (it sorts before every non-empty order) -
 * Element's validOrder accepts it, and rejecting it here would make a
 * third-party client's ""-ordered space sort first there and last here.
 */
const MAX_ORDER_LEN = 50;
const VALID_ORDER = new RegExp(`^[\\x20-\\x7E]{0,${MAX_ORDER_LEN}}$`);

/**
 * The validated `order` string for a space, or null when absent/malformed
 * (non-string, over-long, or non-printable-ASCII content reads as
 * unordered, matching Element's `validOrder`).
 */
export function getSpaceOrder(room: Room): string | null {
	const order = room.getAccountData(SPACE_ORDER_TYPE)?.getContent()?.order;
	return typeof order === "string" && VALID_ORDER.test(order) ? order : null;
}

/**
 * Root-space sort: ordered spaces first (code-point compare, NOT
 * localeCompare - MSC3230 orders are opaque ASCII strings), unordered
 * after, both tiers tie-broken by name. The one comparator behind the
 * sidebar's root order; `getSpaceTree` applies it.
 */
export function compareSpaceOrder(a: RoomSummary, b: RoomSummary): number {
	if (a.spaceOrder !== null && b.spaceOrder !== null) {
		if (a.spaceOrder !== b.spaceOrder) {
			return a.spaceOrder < b.spaceOrder ? -1 : 1;
		}
	} else if (a.spaceOrder !== null) {
		return -1;
	} else if (b.spaceOrder !== null) {
		return 1;
	}
	// Name first so the unordered tier keeps the pre-existing name-sorted
	// rail; roomId last so equal orders AND equal names still sort the
	// same in every session and locale (Element ties on roomId).
	const byName = a.name.localeCompare(b.name);
	if (byName !== 0) return byName;
	return a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0;
}

/** The slice of `ClientContextValue` the move action needs. */
interface SpaceOrderContext {
	client: MatrixClient;
	summaries: SummariesStore;
	optimisticallySetSpaceOrder: (roomId: string, order: string | null) => void;
}

/**
 * Per-client chains serializing order writes per space, so rapid repeated
 * moves can't commit opposite values out of order server-side (same
 * discipline as the tag and marked-unread writers).
 */
const orderWriteChains = new WeakMap<
	MatrixClient,
	Map<string, Promise<void>>
>();

function enqueueOrderWrite(
	client: MatrixClient,
	roomId: string,
	order: string,
): Promise<void> {
	// The SDK types setRoomAccountData against its known event-type map,
	// which doesn't include this Element-namespaced type - same escape
	// hatch as the unstable marked-unread write.
	const typeKey = SPACE_ORDER_TYPE as unknown as Parameters<
		MatrixClient["setRoomAccountData"]
	>[1];
	return enqueueOwnerKeyedWrite(orderWriteChains, client, roomId, () =>
		client.setRoomAccountData(roomId, typeKey, { order }).then(() => {}),
	);
}

/**
 * Move the root space at `fromIndex` to `toIndex` within `roots` (the
 * sidebar's current root order). Computes the minimal set of order-string
 * writes (Element's algorithm), applies each optimistically so the rail
 * re-sorts instantly, and converges any failed write back to the SDK's
 * authoritative value - one toast for the whole batch, since the rail
 * move is the only feedback surface.
 */
export function moveRootSpace(
	ctx: SpaceOrderContext,
	roots: readonly RoomSummary[],
	fromIndex: number,
	toIndex: number,
): void {
	const updates = reorderLexicographically(
		roots.map((r) => r.spaceOrder ?? undefined),
		fromIndex,
		toIndex,
		MAX_ORDER_LEN,
	);
	if (updates.length === 0) return;

	const writes = updates.map(({ index, order }) => {
		const root = roots[index];
		if (root === undefined) {
			return Promise.reject(
				new RangeError("Space order update index is out of bounds"),
			);
		}
		const roomId = root.roomId;
		ctx.optimisticallySetSpaceOrder(roomId, order);
		return enqueueOrderWrite(ctx.client, roomId, order).catch((err) => {
			// A newer move already re-stamped this space: its own queued
			// write owns the outcome now, so neither revert (that would
			// clobber the newer optimistic value) nor count this toward
			// the batch toast (the final order may well save fine).
			if (ctx.summaries[roomId]?.spaceOrder !== order) return;
			const room = ctx.client.getRoom(roomId);
			ctx.optimisticallySetSpaceOrder(
				roomId,
				room ? getSpaceOrder(room) : null,
			);
			throw err;
		});
	});

	void Promise.allSettled(writes).then((results) => {
		const failed = results.find(
			(r): r is PromiseRejectedResult => r.status === "rejected",
		);
		if (failed) {
			reportError(failed.reason, {
				userMessage: "Couldn't save the space order.",
				logLabel: "Space order write failed",
			});
		}
	});
}
