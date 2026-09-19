import { expect, it } from "vitest";
import { imageExtension } from "./imageExtension";

it("uses safe image extensions and rejects unknown or document MIME types", () => {
	for (const [mime, extension] of [
		["image/png", "png"],
		["IMAGE/JPEG; charset=binary", "jpg"],
		["image/svg+xml", "svg"],
		["image/webp", "webp"],
		["text/html", null],
		["image/../../html", null],
		["constructor", null],
		[null, null],
	]) {
		expect(imageExtension(mime ?? null)).toBe(extension);
	}
});
