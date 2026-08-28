import { describe, expect, it } from "vitest";
import { sanitizeFilename } from "./filename";

// Build control-char strings programmatically so no raw control bytes live in
// this source file.
const BS = String.fromCharCode(0x08); // backspace
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);

describe("sanitizeFilename", () => {
	it("keeps a normal filename, including internal spaces", () => {
		expect(sanitizeFilename("photo.png")).toBe("photo.png");
		expect(sanitizeFilename("my file.png")).toBe("my file.png");
	});

	it("falls back to 'file' for empty/whitespace/missing names", () => {
		expect(sanitizeFilename("")).toBe("file");
		expect(sanitizeFilename("   ")).toBe("file");
		expect(sanitizeFilename(undefined)).toBe("file");
		expect(sanitizeFilename(null)).toBe("file");
	});

	it("strips ASCII control characters (C0 + DEL)", () => {
		expect(sanitizeFilename(`a${BS}b${NUL}c${DEL}.png`)).toBe("abc.png");
		// A name that is only control chars collapses to the fallback.
		expect(sanitizeFilename(`${BS}${NUL}${DEL}`)).toBe("file");
	});

	it("strips path separators", () => {
		expect(sanitizeFilename("a/b\\c.png")).toBe("abc.png");
	});

	it("trims surrounding whitespace", () => {
		expect(sanitizeFilename("  report.pdf  ")).toBe("report.pdf");
	});
});
