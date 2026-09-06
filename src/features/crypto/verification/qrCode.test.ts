import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { requiredAt } from "../../../test/assertions";
import { encodeVerificationQr } from "./qrCode";

/**
 * Stand-in for what `VerificationRequest.generateQRCode()` returns: a
 * `Uint8ClampedArray` of arbitrary bytes, including values >= 0x80 that a
 * string round-trip would widen.
 */
function makeBytes(length: number): Uint8ClampedArray {
	return new Uint8ClampedArray(
		Array.from({ length }, (_, i) => (i * 37 + 128) % 256),
	);
}

/** Rebuild the module grid from the SVG path this module produces. */
function gridFromPath(size: number, path: string): boolean[][] {
	const grid = Array.from({ length: size }, () => new Array(size).fill(false));
	const run = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
	let match = run.exec(path);
	while (match !== null) {
		const [, xs, ys, ws, backWs] = match;
		expect(ws).toBe(backWs);
		const x = Number(xs);
		const y = Number(ys);
		const row = requiredAt(grid, y, "QR row");
		for (let i = 0; i < Number(ws); i++) row[x + i] = true;
		match = run.exec(path);
	}
	return grid;
}

describe("encodeVerificationQr", () => {
	it("encodes the raw bytes rather than a string round-trip", () => {
		const bytes = makeBytes(120);
		const asString = String.fromCharCode(...bytes);

		// Every byte here is >= 0x80, so UTF-8 re-encoding doubles the payload
		// and forces a larger QR version. A code the same size as the string
		// route would mean the bytes went through a string and the scan would
		// fail verification.
		expect(encodeVerificationQr(bytes).size).toBeLessThan(
			encode(asString).size,
		);
	});

	it("accepts a Uint8ClampedArray (uqr needs a real Array for byte mode)", () => {
		// uqr picks its byte-mode segment via Array.isArray(), which is false
		// for a typed array; without the conversion this throws.
		expect(() => encode(makeBytes(60) as unknown as number[])).toThrow();
		expect(() => encodeVerificationQr(makeBytes(60))).not.toThrow();
	});

	it("surrounds the code with a 4-module quiet zone", () => {
		const bytes = makeBytes(120);
		const { size, path } = encodeVerificationQr(bytes);
		const bare = encode(Array.from(bytes), { border: 0 });

		expect(size).toBe(bare.size + 8);

		// The border rows and columns must carry no dark modules, or readers
		// lose the finder patterns against a dark backdrop.
		const grid = gridFromPath(size, path);
		for (let i = 0; i < size; i++) {
			for (let j = 0; j < 4; j++) {
				expect(requiredAt(requiredAt(grid, j, "top row"), i)).toBe(false);
				expect(
					requiredAt(requiredAt(grid, size - 1 - j, "bottom row"), i),
				).toBe(false);
				expect(requiredAt(requiredAt(grid, i, "side row"), j)).toBe(false);
				expect(requiredAt(requiredAt(grid, i, "side row"), size - 1 - j)).toBe(
					false,
				);
			}
		}
	});

	it("covers exactly the dark modules, merged into horizontal runs", () => {
		const bytes = makeBytes(120);
		const { size, path } = encodeVerificationQr(bytes);
		const expected = encode(Array.from(bytes), { border: 4 });

		expect(gridFromPath(size, path)).toEqual(expected.data);

		// Merging is the point of the hand-rolled path: one segment per run,
		// so there must be fewer segments than dark modules.
		const segments = path.match(/M\d+ \d+h/g)?.length ?? 0;
		const dark = expected.data.flat().filter(Boolean).length;
		expect(segments).toBeGreaterThan(0);
		expect(segments).toBeLessThan(dark);
	});
});
