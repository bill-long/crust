import { describe, expect, it } from "vitest";
import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
	it("returns bytes below 1 KB without scaling", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1023)).toBe("1023 B");
	});

	it("scales into KB/MB/GB with one decimal below 10 of a unit", () => {
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
		expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
		expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
	});

	it("drops the decimal at 10 or more of a unit", () => {
		expect(formatBytes(10 * 1024)).toBe("10 KB");
		expect(formatBytes(42 * 1024 * 1024)).toBe("42 MB");
	});

	it("caps at GB (does not roll over to TB)", () => {
		expect(formatBytes(1024 ** 4)).toBe("1024 GB");
	});

	it("returns an empty string for negative or non-finite input", () => {
		expect(formatBytes(-1)).toBe("");
		expect(formatBytes(Number.NaN)).toBe("");
		expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("");
	});
});
