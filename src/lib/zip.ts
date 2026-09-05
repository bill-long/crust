/**
 * Minimal ZIP writer: STORE (no compression) entries only, hand-rolled so
 * chat export (#530) can bundle attachments without adding an archive
 * dependency (same call as the service worker's icon cache - see
 * AGENTS.md "Ask first"). The format subset is fixed and small: local
 * file headers, a central directory, and the end-of-central-directory
 * record, all with UTF-8 names. No zip64 - entries and the archive must
 * stay under 4 GiB, which `addEntry` enforces.
 *
 * STORE is the right trade for this caller: media attachments are
 * already compressed formats, and text parts are small next to them.
 */

/** Standard CRC-32 (IEEE 802.3), table-driven. */
const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

/** Feed one chunk into a running CRC; start from {@link CRC32_INIT}. */
export function crc32Update(crc: number, chunk: Uint8Array): number {
	let c = crc;
	for (let i = 0; i < chunk.length; i++) {
		const byte = chunk[i];
		if (byte === undefined) break;
		const tableEntry = CRC_TABLE[(c ^ byte) & 0xff];
		if (tableEntry === undefined) {
			throw new RangeError("CRC table index is out of bounds");
		}
		c = tableEntry ^ (c >>> 8);
	}
	return c;
}

export const CRC32_INIT = 0xffffffff;

export function crc32Final(crc: number): number {
	return (crc ^ 0xffffffff) >>> 0;
}

export function crc32(data: Uint8Array): number {
	return crc32Final(crc32Update(CRC32_INIT, data));
}

/** ~4 MiB CRC slices keep each main-thread turn well under the budget. */
const CRC_SLICE = 4 * 1024 * 1024;

/**
 * CRC-32 of a large buffer computed in slices, yielding the main thread
 * between them via `yieldFn` - a whole-buffer pass over a multi-hundred-MB
 * attachment would otherwise freeze the UI for seconds.
 */
export async function crc32Chunked(
	data: Uint8Array,
	yieldFn: () => Promise<void>,
): Promise<number> {
	let crc = CRC32_INIT;
	for (let at = 0; at < data.length; at += CRC_SLICE) {
		crc = crc32Update(crc, data.subarray(at, at + CRC_SLICE));
		if (at + CRC_SLICE < data.length) await yieldFn();
	}
	return crc32Final(crc);
}

/** 4 GiB minus one: the largest size representable without zip64. */
const MAX_UINT32 = 0xffffffff;

interface ZipEntry {
	nameBytes: Uint8Array;
	data: Uint8Array;
	crc: number;
	/** Byte offset of the entry's local header in the archive. */
	offset: number;
}

/**
 * Builds a ZIP archive incrementally. Feed entries with {@link addEntry},
 * take the finished archive once with {@link toBlob}. Not reusable after
 * toBlob.
 */
export class ZipWriter {
	private readonly entries: ZipEntry[] = [];
	private readonly parts: Uint8Array[] = [];
	private offset = 0;

	/**
	 * Append one file. `name` is the path inside the archive (forward
	 * slashes for folders, e.g. "media/image.png"); the caller is
	 * responsible for uniqueness.
	 */
	addEntry(name: string, data: Uint8Array, precomputedCrc?: number): void {
		if (this.finished) {
			// Appending after the central directory/EOCD would corrupt the
			// archive - the writer is single-use by contract.
			throw new Error("ZIP archive already finalized");
		}
		const nameBytes = new TextEncoder().encode(name);
		if (nameBytes.length > 0xffff) {
			throw new Error("ZIP entry name too long");
		}
		if (data.length > MAX_UINT32) {
			throw new Error("ZIP entry too large (no zip64 support)");
		}
		if (this.entries.length >= 0xffff) {
			// The EOCD entry counts are uint16; letting them wrap would
			// silently corrupt the archive.
			throw new Error("ZIP entry count limit exceeded (no zip64 support)");
		}
		const crc = precomputedCrc ?? crc32(data);

		// Local file header.
		const header = new DataView(new ArrayBuffer(30));
		header.setUint32(0, 0x04034b50, true); // signature
		header.setUint16(4, 20, true); // version needed
		header.setUint16(6, 0x0800, true); // flags: UTF-8 names
		header.setUint16(8, 0, true); // method: STORE
		header.setUint16(10, 0, true); // mod time (unset)
		header.setUint16(12, 0x21, true); // mod date (1980-01-01)
		header.setUint32(14, crc, true);
		header.setUint32(18, data.length, true); // compressed size
		header.setUint32(22, data.length, true); // uncompressed size
		header.setUint16(26, nameBytes.length, true);
		header.setUint16(28, 0, true); // extra length

		this.entries.push({ nameBytes, data, crc, offset: this.offset });
		this.push(new Uint8Array(header.buffer));
		this.push(nameBytes);
		this.push(data);
	}

	/** The finished archive as raw bytes. */
	toBytes(): Uint8Array {
		this.finish();
		const out = new Uint8Array(this.offset);
		let at = 0;
		for (const part of this.parts) {
			out.set(part, at);
			at += part.length;
		}
		return out;
	}

	/** The finished archive. Built from the accumulated parts directly -
	 *  no whole-archive copy, unlike {@link toBytes}. */
	toBlob(): Blob {
		this.finish();
		return new Blob(this.parts as BlobPart[], {
			type: "application/zip",
		});
	}

	private finished = false;

	private finish(): void {
		if (this.finished) return;
		this.finished = true;
		const centralStart = this.offset;
		for (const entry of this.entries) {
			const header = new DataView(new ArrayBuffer(46));
			header.setUint32(0, 0x02014b50, true); // signature
			header.setUint16(4, 20, true); // version made by
			header.setUint16(6, 20, true); // version needed
			header.setUint16(8, 0x0800, true); // flags: UTF-8 names
			header.setUint16(10, 0, true); // method: STORE
			header.setUint16(12, 0, true); // mod time
			header.setUint16(14, 0x21, true); // mod date
			header.setUint32(16, entry.crc, true);
			header.setUint32(20, entry.data.length, true);
			header.setUint32(24, entry.data.length, true);
			header.setUint16(28, entry.nameBytes.length, true);
			// comment/extra/disk/attrs all zero.
			header.setUint32(42, entry.offset, true);
			this.push(new Uint8Array(header.buffer));
			this.push(entry.nameBytes);
		}
		const centralSize = this.offset - centralStart;

		const eocd = new DataView(new ArrayBuffer(22));
		eocd.setUint32(0, 0x06054b50, true); // signature
		eocd.setUint16(8, this.entries.length, true); // entries on this disk
		eocd.setUint16(10, this.entries.length, true); // entries total
		eocd.setUint32(12, centralSize, true);
		eocd.setUint32(16, centralStart, true);
		this.push(new Uint8Array(eocd.buffer));

		if (this.offset > MAX_UINT32) {
			throw new Error("ZIP archive too large (no zip64 support)");
		}
	}

	private push(bytes: Uint8Array): void {
		this.parts.push(bytes);
		this.offset += bytes.length;
	}
}
