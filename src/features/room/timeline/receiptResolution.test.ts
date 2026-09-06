import type { MatrixEvent } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { createReceiptResolver } from "./receiptResolution";

const raw = (id: string): MatrixEvent => ({ getId: () => id }) as MatrixEvent;
const drawn =
	(ids: string[]) =>
	(id: string): boolean =>
		ids.includes(id);

describe("createReceiptResolver", () => {
	it("keeps a receipt that already points at a drawn row", () => {
		const win = [raw("$a"), raw("$b")];
		expect(createReceiptResolver(win, drawn(["$a", "$b"]))("$b")).toBe("$b");
	});

	it("walks back to the row a reaction receipt really marks", () => {
		const win = [raw("$a"), raw("$b"), raw("$reaction")];
		expect(createReceiptResolver(win, drawn(["$a", "$b"]))("$reaction")).toBe(
			"$b",
		);
	});

	it("walks past sparse window slots", () => {
		const win = [raw("$a")];
		win.length = 2;
		win[2] = raw("$reaction");
		expect(createReceiptResolver(win, drawn(["$a"]))("$reaction")).toBe("$a");
	});

	it("gives up when the receipt is outside the window", () => {
		const win = [raw("$b"), raw("$c")];
		expect(createReceiptResolver(win, drawn(["$b"]))("$older")).toBeNull();
	});

	it("gives up when nothing back to the start is drawable", () => {
		const win = [raw("$edit1"), raw("$edit2")];
		expect(createReceiptResolver(win, drawn([]))("$edit2")).toBeNull();
	});

	it("scans the window once however many receipts it resolves", () => {
		// The read-by avatars resolve one receipt per room member; re-scanning
		// a 2000-event window for each is main-thread work in the millions.
		let reads = 0;
		const win = Array.from({ length: 50 }, (_, i) => {
			const id = `$e${i}`;
			return {
				getId: () => {
					reads++;
					return id;
				},
			} as MatrixEvent;
		});
		const resolve = createReceiptResolver(win, () => false);
		for (let i = 0; i < 20; i++) resolve(`$missing${i}`);
		expect(reads).toBeLessThanOrEqual(win.length);
	});

	it("does not build its index for receipts already on a drawn row", () => {
		let reads = 0;
		const win = [
			{
				getId: () => {
					reads++;
					return "$a";
				},
			} as MatrixEvent,
		];
		createReceiptResolver(win, drawn(["$a"]))("$a");
		expect(reads).toBe(0);
	});
});
