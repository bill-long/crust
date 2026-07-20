import { describe, expect, it } from "vitest";
import { userFacingErrorMessage } from "./errorMessage";

describe("userFacingErrorMessage", () => {
	it("hides WebCrypto DOMException jargon behind the fallback", () => {
		expect(
			userFacingErrorMessage(
				new DOMException(
					"The operation failed for some reason",
					"OperationError",
				),
				"Export failed. Please try again.",
			),
		).toBe("Export failed. Please try again.");
	});

	it("hides network TypeError jargon behind the fallback", () => {
		expect(
			userFacingErrorMessage(
				new TypeError("Failed to fetch"),
				"Reset failed. Please try again.",
			),
		).toBe("Reset failed. Please try again.");
	});

	it("keeps curated and server-provided Error messages", () => {
		// e.g. a MatrixError carrying the server's "Invalid password".
		expect(userFacingErrorMessage(new Error("Invalid password"), "x")).toBe(
			"Invalid password",
		);
	});

	it("uses the fallback for non-Error throws and empty messages", () => {
		expect(userFacingErrorMessage("string throw", "x")).toBe("x");
		expect(userFacingErrorMessage(undefined, "x")).toBe("x");
		expect(userFacingErrorMessage(new Error(""), "x")).toBe("x");
	});
});
