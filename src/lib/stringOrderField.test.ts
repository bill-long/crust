import { DEFAULT_ALPHABET } from "matrix-js-sdk/lib/utils";
import { describe, expect, it } from "vitest";
import {
	midPointsBetweenStrings,
	moveElement,
	reorderLexicographically,
} from "./stringOrderField";

/**
 * Behavior-locking cases ported from matrix-react-sdk's
 * stringOrderField-test.ts (Apache-2.0), so Crust's reordering matches
 * Element's write-for-write.
 */

/** Sort key semantics of MSC3230 orders: code-point compare, undefined last. */
function applyAndSort(
	orders: Array<string | undefined>,
	ops: ReturnType<typeof reorderLexicographically>,
): Array<[number, string | undefined]> {
	const zipped: Array<[number, string | undefined]> = orders.map((o, i) => [
		i,
		o,
	]);
	for (const { index, order } of ops) {
		zipped[index][1] = order;
	}
	return [...zipped].sort((a, b) => {
		if (a[1] === b[1]) return 0;
		if (a[1] === undefined) return 1;
		if (b[1] === undefined) return -1;
		return a[1] < b[1] ? -1 : 1;
	});
}

const moveTest = (
	orders: Array<string | undefined>,
	fromIndex: number,
	toIndex: number,
	expectedChanges: number,
	maxLength?: number,
): void => {
	const ops = reorderLexicographically(orders, fromIndex, toIndex, maxLength);
	const newOrders = applyAndSort(orders, ops);
	expect(newOrders[toIndex][0]).toBe(fromIndex);
	expect(ops).toHaveLength(expectedChanges);
};

describe("moveElement", () => {
	it("moves without mutating the input", () => {
		const arr = ["a", "b", "c"];
		expect(moveElement(arr, 0, 2)).toEqual(["b", "c", "a"]);
		expect(moveElement(arr, 2, 0)).toEqual(["c", "a", "b"]);
		expect(arr).toEqual(["a", "b", "c"]);
	});
});

describe("midPointsBetweenStrings", () => {
	it("produces distinct in-range midpoints", () => {
		const midpoints = ["a", ...midPointsBetweenStrings("a", "e", 3, 1), "e"]
			.slice()
			.sort();
		expect(midpoints[0]).toBe("a");
		expect(midpoints[4]).toBe("e");
		expect(new Set(midpoints).size).toBe(5);
		expect(midPointsBetweenStrings("      ", "!'Tu:}", 1, 50)).toStrictEqual([
			" S:J\\~",
		]);
	});

	it("returns an empty array when the request is not possible", () => {
		expect(midPointsBetweenStrings("a", "e", 0, 1)).toStrictEqual([]);
		expect(midPointsBetweenStrings("a", "e", 4, 1)).toStrictEqual([]);
	});
});

describe("reorderLexicographically", () => {
	it("is a no-op for equal or out-of-range indices", () => {
		expect(reorderLexicographically(["a", "b"], 1, 1)).toStrictEqual([]);
		expect(reorderLexicographically(["a", "b"], -1, 0)).toStrictEqual([]);
		expect(reorderLexicographically(["a", "b"], 0, 5)).toStrictEqual([]);
		// === length is out of range too (upstream accepted it; we reject).
		expect(reorderLexicographically(["a", "b"], 0, 2)).toStrictEqual([]);
		expect(reorderLexicographically(["a", "b"], 2, 0)).toStrictEqual([]);
	});

	it("works when moving left", () => {
		moveTest(["a", "c", "e", "g", "i"], 2, 1, 1);
	});

	it("works when moving right", () => {
		moveTest(["a", "c", "e", "g", "i"], 1, 2, 1);
	});

	it("works when all orders are undefined", () => {
		moveTest(
			[undefined, undefined, undefined, undefined, undefined, undefined],
			4,
			1,
			2,
		);
	});

	it("works when moving to end and all orders are undefined", () => {
		moveTest(
			[undefined, undefined, undefined, undefined, undefined, undefined],
			1,
			4,
			5,
		);
	});

	it("works when moving left and some orders are undefined", () => {
		moveTest(["a", "c", "e", undefined, undefined, undefined], 5, 2, 1);
		moveTest(["a", "a", "e", undefined, undefined, undefined], 5, 1, 2);
	});

	it("works moving to the start when all is undefined", () => {
		moveTest([undefined, undefined, undefined, undefined], 2, 0, 1);
	});

	it("works moving to the end when all is undefined", () => {
		moveTest([undefined, undefined, undefined, undefined], 1, 3, 4);
	});

	it("works moving right when all is undefined", () => {
		moveTest([undefined, undefined, undefined, undefined], 1, 2, 3);
	});

	it("works moving left when right is undefined", () => {
		moveTest(
			["20", undefined, undefined, undefined, undefined, undefined],
			4,
			2,
			2,
		);
	});

	it("works moving right when right is undefined", () => {
		moveTest(
			["50", undefined, undefined, undefined, undefined, undefined, undefined],
			1,
			4,
			4,
		);
	});

	it("works moving left when right is defined", () => {
		moveTest(["10", "20", "30", "40", undefined, undefined], 3, 1, 1);
	});

	it("works moving right when right is defined", () => {
		moveTest(["10", "20", "30", "40", "50", undefined], 1, 3, 1);
	});

	it("works moving left when all is defined", () => {
		moveTest(["11", "13", "15", "17", "19"], 2, 1, 1);
	});

	it("works moving right when all is defined", () => {
		moveTest(["11", "13", "15", "17", "19"], 1, 2, 1);
	});

	it("works moving left into no left space", () => {
		moveTest(["11", "12", "13", "14", "19"], 3, 1, 2, 2);
		moveTest(
			[
				DEFAULT_ALPHABET.charAt(0),
				DEFAULT_ALPHABET.charAt(1),
				DEFAULT_ALPHABET.charAt(2),
				DEFAULT_ALPHABET.charAt(3),
				DEFAULT_ALPHABET.charAt(4),
				DEFAULT_ALPHABET.charAt(5),
			],
			5,
			1,
			5,
			1,
		);
	});

	it("works moving right into no right space", () => {
		moveTest(["15", "16", "17", "18", "19"], 1, 3, 3, 2);
		moveTest(
			[
				DEFAULT_ALPHABET.charAt(DEFAULT_ALPHABET.length - 5),
				DEFAULT_ALPHABET.charAt(DEFAULT_ALPHABET.length - 4),
				DEFAULT_ALPHABET.charAt(DEFAULT_ALPHABET.length - 3),
				DEFAULT_ALPHABET.charAt(DEFAULT_ALPHABET.length - 2),
				DEFAULT_ALPHABET.charAt(DEFAULT_ALPHABET.length - 1),
			],
			1,
			3,
			3,
			1,
		);
	});

	it("works moving right into no left space", () => {
		moveTest(["11", "12", "13", "14", "15", "16", undefined], 1, 3, 3);
		moveTest(["0", "1", "2", "3", "4", "5"], 1, 3, 3, 1);
	});

	it("works moving left into no right space", () => {
		moveTest(["15", "16", "17", "18", "19"], 4, 3, 4, 2);
		moveTest(
			[
				DEFAULT_ALPHABET.charAt(DEFAULT_ALPHABET.length - 5),
				DEFAULT_ALPHABET.charAt(DEFAULT_ALPHABET.length - 4),
				DEFAULT_ALPHABET.charAt(DEFAULT_ALPHABET.length - 3),
				DEFAULT_ALPHABET.charAt(DEFAULT_ALPHABET.length - 2),
				DEFAULT_ALPHABET.charAt(DEFAULT_ALPHABET.length - 1),
			],
			4,
			3,
			4,
			1,
		);
	});
});
