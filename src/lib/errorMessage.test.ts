import { MatrixError } from "matrix-js-sdk";
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

	it("unwraps a MatrixError to the server's own error text", () => {
		// The SDK's composed message is noise ("MatrixError: [401] Invalid
		// identifier or password (https://hs/...)"); the body's `error`
		// field is the text written for humans.
		const err = new MatrixError(
			{ errcode: "M_FORBIDDEN", error: "Invalid identifier or password" },
			401,
			"https://hs.example/_matrix/client/v3/account/deactivate",
		);
		expect(userFacingErrorMessage(err, "x")).toBe(
			"Invalid identifier or password",
		);
	});

	it("hides a bodyless MatrixError behind the fallback", () => {
		const err = new MatrixError({ errcode: "M_UNKNOWN" }, 500);
		expect(userFacingErrorMessage(err, "Something broke.")).toBe(
			"Something broke.",
		);
	});

	it("uses the fallback for non-Error throws and empty messages", () => {
		expect(userFacingErrorMessage("string throw", "x")).toBe("x");
		expect(userFacingErrorMessage(undefined, "x")).toBe("x");
		expect(userFacingErrorMessage(new Error(""), "x")).toBe("x");
	});
});
