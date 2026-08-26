import type { MatrixEvent } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { resolveReceiptToDisplayable } from "./receiptResolution";

const raw = (id: string): MatrixEvent => ({ getId: () => id }) as MatrixEvent;
const displayable = (ids: string[]) => (id: string) => ids.includes(id);

describe("resolveReceiptToDisplayable", () => {
	it("keeps a receipt that already points at a drawn row", () => {
		const win = [raw("$a"), raw("$b")];
		expect(
			resolveReceiptToDisplayable("$b", displayable(["$a", "$b"]), win),
		).toBe("$b");
	});

	it("walks back to the row a reaction receipt really marks", () => {
		const win = [raw("$a"), raw("$b"), raw("$reaction")];
		expect(
			resolveReceiptToDisplayable("$reaction", displayable(["$a", "$b"]), win),
		).toBe("$b");
	});

	it("gives up when the receipt is outside the window", () => {
		const win = [raw("$b"), raw("$c")];
		expect(
			resolveReceiptToDisplayable("$older", displayable(["$b"]), win),
		).toBeNull();
	});

	it("gives up when nothing back to the start is drawable", () => {
		const win = [raw("$edit1"), raw("$edit2")];
		expect(
			resolveReceiptToDisplayable("$edit2", displayable([]), win),
		).toBeNull();
	});
});
