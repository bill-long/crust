import { encode } from "uqr";

/**
 * A QR code reduced to what an <svg> needs: a square module grid (quiet zone
 * included) and the path data covering its dark modules, in module units.
 */
export interface QrCodeSvg {
	/** Grid width and height in modules, quiet zone included. */
	size: number;
	/** SVG path `d` for the dark modules, in module units. */
	path: string;
}

/**
 * Quiet zone, in modules. The spec's minimum for a scannable code is 4; uqr
 * defaults to 1, which readers frequently miss when the code sits against a
 * busy background.
 */
const QUIET_ZONE = 4;

/**
 * Encode the raw bytes from `VerificationRequest.generateQRCode()` as an SVG
 * path for display.
 *
 * The SDK hands us bytes, not text, and re-encoding them through a JS string
 * corrupts the payload (UTF-8 widens any byte >= 0x80), so this must go
 * through a byte-mode segment. `uqr` picks that mode via `Array.isArray()`,
 * which is false for the `Uint8ClampedArray` we are given - passing it
 * straight through throws `uqr only supports encoding string and binary data,
 * but got: object`. Hence `Array.from`.
 *
 * Error correction stays at uqr's default L. The code is displayed on a clean
 * screen rather than printed, so there is no damage to recover from, and a
 * higher level would only buy redundancy by adding modules - which makes each
 * one smaller on screen and the scan harder.
 */
export function encodeVerificationQr(bytes: Uint8ClampedArray): QrCodeSvg {
	const result = encode(Array.from(bytes), { border: QUIET_ZONE });

	// One path segment per horizontal run of dark modules rather than per
	// module: a verification code is ~2,000 dark modules, and the runs cut the
	// `d` attribute roughly in half at no fidelity cost.
	const parts: string[] = [];
	for (let row = 0; row < result.size; row++) {
		const cells = result.data[row];
		let col = 0;
		while (col < result.size) {
			if (!cells[col]) {
				col++;
				continue;
			}
			const start = col;
			while (col < result.size && cells[col]) col++;
			parts.push(`M${start} ${row}h${col - start}v1h-${col - start}z`);
		}
	}

	return { size: result.size, path: parts.join("") };
}
