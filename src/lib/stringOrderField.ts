import {
	alphabetPad,
	baseToString,
	DEFAULT_ALPHABET,
	stringToBase,
} from "matrix-js-sdk/lib/utils";

/**
 * Lexicographic order-string arithmetic for MSC3230-style `order` fields
 * (printable-ASCII strings compared by Unicode code points).
 *
 * Ported from matrix-react-sdk's `utils/stringOrderField.ts` (Apache-2.0,
 * (c) 2021 The Matrix.org Foundation C.I.C.) so Crust reorders exactly the
 * way Element does: minimal writes, midpoint insertion, and a bounded
 * renumber when neighbours are too tight to fit a midpoint between.
 */

/** Immutable move of `arr[fromIndex]` to `toIndex`. */
export function moveElement<T>(
	arr: readonly T[],
	fromIndex: number,
	toIndex: number,
): T[] {
	const next = [...arr];
	next.splice(toIndex, 0, ...next.splice(fromIndex, 1));
	return next;
}

/**
 * Up to `count` strings strictly between `a` and `b` (both in `alphabet`
 * base ordering), each at most `maxLen` characters. Returns `[]` when the
 * gap cannot fit `count` distinct values even at `maxLen` - the caller is
 * expected to widen the range it rewrites instead.
 */
export function midPointsBetweenStrings(
	a: string,
	b: string,
	count: number,
	maxLen: number,
	alphabet = DEFAULT_ALPHABET,
): string[] {
	const padN = Math.min(Math.max(a.length, b.length), maxLen);
	const padA = alphabetPad(a, padN, alphabet);
	const padB = alphabetPad(b, padN, alphabet);
	const baseA = stringToBase(padA, alphabet);
	const baseB = stringToBase(padB, alphabet);

	if (baseB - baseA - BigInt(1) < count) {
		if (padN < maxLen) {
			// This recurses once at most due to the new limit of n+1.
			return midPointsBetweenStrings(
				alphabetPad(padA, padN + 1, alphabet),
				alphabetPad(padB, padN + 1, alphabet),
				count,
				padN + 1,
				alphabet,
			);
		}
		return [];
	}

	const step = (baseB - baseA) / BigInt(count + 1);
	const start = BigInt(baseA + step);
	return Array(count)
		.fill(undefined)
		.map((_, i) => baseToString(start + BigInt(i) * step, alphabet));
}

export interface OrderUpdate {
	/** Index into the caller's ORIGINAL (pre-move) array. */
	index: number;
	order: string;
}

/**
 * The minimal set of order-string updates that realises moving
 * `orders[fromIndex]` to `toIndex`, where `undefined` entries sort after
 * every defined order. Mutates nothing; returns `[]` for a no-op move.
 */
export function reorderLexicographically(
	orders: Array<string | undefined>,
	fromIndex: number,
	toIndex: number,
	maxLen = 50,
): OrderUpdate[] {
	// Sanity check inputs. (Upstream accepts === length, but that index is
	// out of range for everything below - reject it.)
	if (
		fromIndex < 0 ||
		toIndex < 0 ||
		fromIndex >= orders.length ||
		toIndex >= orders.length ||
		fromIndex === toIndex
	) {
		return [];
	}

	// Zip orders with their indices to simplify later index wrangling.
	const ordersWithIndices = orders.map((order, index) => ({ index, order }));
	// Apply the fundamental order update to the zipped array.
	const newOrder = moveElement(ordersWithIndices, fromIndex, toIndex);

	// Check if we have to fill undefined orders to complete placement.
	const orderToLeftUndefined = newOrder[toIndex - 1]?.order === undefined;

	let leftBoundIdx = toIndex;
	let rightBoundIdx = toIndex;

	let canMoveLeft = true;
	const orderAfterTarget = newOrder[toIndex + 1]?.order;
	// Number.MAX_VALUE is an integer-valued double, so BigInt() converts it
	// exactly (unlike upstream's BigInt(Number.MIN_VALUE), which throws);
	// it exceeds any real order's base (alphabet 95^maxLen 50 < 1e99 <
	// 1.8e308), making it a safe "unbounded above" sentinel.
	const nextBase =
		orderAfterTarget !== undefined
			? stringToBase(orderAfterTarget)
			: BigInt(Number.MAX_VALUE);

	// Check how far left we would have to mutate to fit in that direction.
	for (let i = toIndex - 1, j = 1; i >= 0; i--, j++) {
		const order = newOrder[i]?.order;
		if (order !== undefined && nextBase - stringToBase(order) > j) break;
		leftBoundIdx = i;
	}

	// Verify the left move would be sufficient.
	const firstOrder = newOrder[0]?.order;
	const firstOrderBase =
		firstOrder === undefined ? undefined : stringToBase(firstOrder);
	const bigToIndex = BigInt(toIndex);
	if (
		leftBoundIdx === 0 &&
		firstOrderBase !== undefined &&
		nextBase - firstOrderBase <= bigToIndex &&
		firstOrderBase <= bigToIndex
	) {
		canMoveLeft = false;
	}

	const canDisplaceRight = !orderToLeftUndefined;
	let canMoveRight = canDisplaceRight;
	if (canDisplaceRight) {
		const orderBeforeTarget = newOrder[toIndex - 1]?.order;
		const prevBase =
			orderBeforeTarget !== undefined
				? stringToBase(orderBeforeTarget)
				: BigInt(Number.MIN_SAFE_INTEGER);

		// Check how far right we would have to mutate to fit in that direction.
		for (let i = toIndex + 1, j = 1; i < newOrder.length; i++, j++) {
			const order = newOrder[i]?.order;
			if (order === undefined || stringToBase(order) - prevBase > j) break;
			rightBoundIdx = i;
		}

		// Verify the right move would be sufficient.
		const rightBoundOrder = newOrder[rightBoundIdx]?.order;
		if (
			rightBoundIdx === newOrder.length - 1 &&
			(rightBoundOrder !== undefined
				? stringToBase(rightBoundOrder)
				: BigInt(Number.MAX_VALUE)) -
				prevBase <=
				rightBoundIdx - toIndex
		) {
			canMoveRight = false;
		}
	}

	// Pick the cheaper direction.
	const leftDiff = canMoveLeft
		? toIndex - leftBoundIdx
		: Number.MAX_SAFE_INTEGER;
	const rightDiff = canMoveRight
		? rightBoundIdx - toIndex
		: Number.MAX_SAFE_INTEGER;
	if (orderToLeftUndefined || leftDiff < rightDiff) {
		rightBoundIdx = toIndex;
	} else {
		leftBoundIdx = toIndex;
	}

	const prevOrder = newOrder[leftBoundIdx - 1]?.order ?? "";
	const nextOrder =
		newOrder[rightBoundIdx + 1]?.order ??
		DEFAULT_ALPHABET.charAt(DEFAULT_ALPHABET.length - 1).repeat(
			prevOrder.length || 1,
		);

	const changes = midPointsBetweenStrings(
		prevOrder,
		nextOrder,
		1 + rightBoundIdx - leftBoundIdx,
		maxLen,
	);

	return changes.map((order, i) => {
		const target = newOrder[leftBoundIdx + i];
		if (target === undefined) {
			throw new RangeError("Order update target is out of bounds");
		}
		return { index: target.index, order };
	});
}
