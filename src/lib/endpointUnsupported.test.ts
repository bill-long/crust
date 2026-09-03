import { MatrixError } from "matrix-js-sdk";
import { describe, expect, it } from "vitest";
import { meansEndpointUnsupported } from "./endpointUnsupported";

describe("meansEndpointUnsupported", () => {
	it("is true for the two errcodes a server uses to say 'no such endpoint'", () => {
		expect(
			meansEndpointUnsupported(
				new MatrixError({ errcode: "M_UNRECOGNIZED", error: "nope" }, 404),
			),
		).toBe(true);
		expect(meansEndpointUnsupported({ errcode: "M_NOT_FOUND" })).toBe(true);
	});

	it("is false for a bare status with no Matrix body, which is a proxy, not the server", () => {
		expect(meansEndpointUnsupported({ httpStatus: 404 })).toBe(false);
		expect(meansEndpointUnsupported({ httpStatus: 405 })).toBe(false);
	});

	it("is false for everything transient", () => {
		expect(
			meansEndpointUnsupported(
				new MatrixError({ errcode: "M_UNKNOWN", error: "bad gateway" }, 502),
			),
		).toBe(false);
		expect(
			meansEndpointUnsupported(
				new MatrixError({ errcode: "M_LIMIT_EXCEEDED", error: "slow" }, 429),
			),
		).toBe(false);
		expect(meansEndpointUnsupported(new TypeError("Failed to fetch"))).toBe(
			false,
		);
		expect(meansEndpointUnsupported(null)).toBe(false);
		expect(meansEndpointUnsupported(undefined)).toBe(false);
	});
});
