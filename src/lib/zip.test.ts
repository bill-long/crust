import { describe, expect, it } from "vitest";
import { crc32, crc32Chunked, ZipWriter } from "./zip";

/** Parse the archive's central directory + entry data back out. */
function readZip(bytes: Uint8Array): {
	name: string;
	crc: number;
	size: number;
	data: Uint8Array;
}[] {
	const view = new DataView(bytes.buffer);
	// EOCD is the last 22 bytes (we write no comments).
	const eocdOffset = bytes.length - 22;
	expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
	const count = view.getUint16(eocdOffset + 10, true);
	let offset = view.getUint32(eocdOffset + 16, true);

	const entries = [];
	for (let i = 0; i < count; i++) {
		expect(view.getUint32(offset, true)).toBe(0x02014b50);
		const crc = view.getUint32(offset + 16, true);
		const size = view.getUint32(offset + 24, true);
		const nameLen = view.getUint16(offset + 28, true);
		const localOffset = view.getUint32(offset + 42, true);
		const name = new TextDecoder().decode(
			bytes.subarray(offset + 46, offset + 46 + nameLen),
		);

		// Follow the local header to the data.
		expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
		const localNameLen = view.getUint16(localOffset + 26, true);
		const localExtraLen = view.getUint16(localOffset + 28, true);
		const dataStart = localOffset + 30 + localNameLen + localExtraLen;
		const data = bytes.slice(dataStart, dataStart + size);

		entries.push({ name, crc, size, data });
		offset += 46 + nameLen;
	}
	return entries;
}

describe("crc32", () => {
	it("matches the standard test vector", () => {
		// CRC-32 of ASCII "123456789" is the classic check value.
		expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
	});

	it("hashes the empty input to zero", () => {
		expect(crc32(new Uint8Array(0))).toBe(0);
	});
});

describe("ZipWriter", () => {
	it("produces a structurally valid archive that round-trips its entries", async () => {
		const zip = new ZipWriter();
		const text = new TextEncoder().encode("hello export");
		const binary = new Uint8Array([0, 1, 2, 253, 254, 255]);
		zip.addEntry("export.txt", text);
		zip.addEntry("media/img.bin", binary);

		const entries = readZip(zip.toBytes());
		const [textEntry, binaryEntry] = entries;
		if (textEntry === undefined || binaryEntry === undefined) {
			throw new Error("Expected both ZIP entries to round-trip");
		}
		expect(entries.map((e) => e.name)).toEqual(["export.txt", "media/img.bin"]);
		expect(Array.from(textEntry.data)).toEqual(Array.from(text));
		expect(textEntry.crc).toBe(crc32(text));
		expect(Array.from(binaryEntry.data)).toEqual(Array.from(binary));
		expect(binaryEntry.crc).toBe(crc32(binary));
	});

	it("encodes non-ASCII entry names as UTF-8", async () => {
		const zip = new ZipWriter();
		zip.addEntry("média/café ☕.txt", new Uint8Array([1]));
		const [entry] = readZip(zip.toBytes());
		expect(entry?.name).toBe("média/café ☕.txt");
	});

	it("refuses a 65536th entry instead of wrapping the EOCD counts", () => {
		const zip = new ZipWriter();
		const empty = new Uint8Array(0);
		for (let i = 0; i < 0xffff; i++) {
			zip.addEntry(`f${i}`, empty);
		}
		expect(() => zip.addEntry("one-too-many", empty)).toThrow(/entry count/);
	});

	it("computes the chunked CRC identically to the one-shot pass", async () => {
		// Larger than one slice so at least one yield happens.
		const big = new Uint8Array(5 * 1024 * 1024);
		for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;
		let yields = 0;
		const crc = await crc32Chunked(big, async () => {
			yields += 1;
		});
		expect(crc).toBe(crc32(big));
		expect(yields).toBeGreaterThan(0);
	});

	it("refuses entries after the archive is finalized", () => {
		const zip = new ZipWriter();
		zip.addEntry("a", new Uint8Array([1]));
		zip.toBytes();
		expect(() => zip.addEntry("b", new Uint8Array([2]))).toThrow(/finalized/);
	});

	it("handles an empty archive", async () => {
		const zip = new ZipWriter();
		const entries = readZip(zip.toBytes());
		expect(entries).toEqual([]);
	});
});
