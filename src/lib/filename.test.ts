import { describe, expect, it } from "vitest";
import { sanitizeFilename, wireAttachmentName, wireFilename } from "./filename";

// Build control-char strings programmatically so no raw control bytes live in
// this source file.
const BS = String.fromCharCode(0x08); // backspace
const NUL = String.fromCharCode(0x00);
const DEL = String.fromCharCode(0x7f);

describe("wireFilename", () => {
	it("strips bidi scope controls and trims", () => {
		const RLO = String.fromCharCode(0x202e);
		expect(wireFilename(`  invoice${RLO}gnp.exe `)).toBe("invoicegnp.exe");
	});

	it("refuses a control-bearing name wholesale, and non-strings", () => {
		// A caption-style body with a newline is not a filename; a NUL would
		// corrupt every label it reached. Reject, unlike the send side.
		expect(
			wireFilename("line one" + String.fromCharCode(0x0a) + "two"),
		).toBeNull();
		expect(wireFilename(`a${NUL}b.png`)).toBeNull();
		expect(wireFilename("   ")).toBeNull();
		expect(wireFilename(undefined)).toBeNull();
		expect(wireFilename(42)).toBeNull();
	});

	it("keeps an ordinary name", () => {
		expect(wireFilename("report.pdf")).toBe("report.pdf");
	});
});

describe("wireAttachmentName", () => {
	it("prefers the explicit filename, yielding to the body only when empty", () => {
		expect(wireAttachmentName({ filename: "a.png", body: "caption" })).toBe(
			"a.png",
		);
		expect(wireAttachmentName({ filename: "  ", body: "b.png" })).toBe("b.png");
		expect(
			wireAttachmentName({
				filename: String.fromCharCode(0x202e),
				body: "c.png",
			}),
		).toBe("c.png");
		expect(wireAttachmentName({ body: "d.png" })).toBe("d.png");
	});

	it("does not let a refused explicit filename yield to the body", () => {
		expect(
			wireAttachmentName({ filename: `a${NUL}b.png`, body: "clean.png" }),
		).toBeNull();
		expect(wireAttachmentName({})).toBeNull();
	});
});

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

	it("strips bidi scope controls, so the visible extension is the real one", () => {
		// An unmatched RLO reverses everything after it, so
		// `invoice<RLO>gnp.exe` displays as `invoiceexe.png`. Stripped, not
		// rejected: the result is an odd but honest filename.
		const RLO = String.fromCharCode(0x202e);
		expect(sanitizeFilename(`invoice${RLO}gnp.exe`)).toBe("invoicegnp.exe");
		// The full set is pinned once, in controlChars.test.ts; an isolate
		// here pins that this path delegates to it.
		expect(sanitizeFilename(`a${String.fromCharCode(0x2066)}b.png`)).toBe(
			"ab.png",
		);
	});

	it("keeps a zero-width joiner, which is harmless in a filename", () => {
		const name = `family${String.fromCharCode(0x200d)}photo.png`;
		expect(sanitizeFilename(name)).toBe(name);
	});

	it("strips path separators", () => {
		expect(sanitizeFilename("a/b\\c.png")).toBe("abc.png");
	});

	it("trims surrounding whitespace", () => {
		expect(sanitizeFilename("  report.pdf  ")).toBe("report.pdf");
	});
});
