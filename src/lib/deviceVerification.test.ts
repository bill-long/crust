import { DeviceVerificationStatus } from "matrix-js-sdk/lib/crypto-api";
import { describe, expect, it } from "vitest";
import { deviceVerification } from "./deviceVerification";

function status(overrides: {
	crossSigningVerified?: boolean;
	localVerified?: boolean;
}) {
	return new DeviceVerificationStatus({
		crossSigningVerified: overrides.crossSigningVerified ?? false,
		localVerified: overrides.localVerified ?? false,
	});
}

// The single test locking the single rule (issue #480). If a UI surface
// needs a different interpretation of DeviceVerificationStatus, change the
// rule here - do not fork it at the call site.
describe("deviceVerification", () => {
	it("verified only when cross-signed by the current identity", () => {
		expect(deviceVerification(status({ crossSigningVerified: true }))).toBe(
			"verified",
		);
	});

	it("does NOT count localVerified - always true for own devices (issue #420)", () => {
		expect(
			deviceVerification(
				status({ crossSigningVerified: false, localVerified: true }),
			),
		).toBe("unverified");
	});

	it("treats a missing status as unknown, never as a confident unverified", () => {
		// null: the SDK holds no keys for the device. undefined: crypto is
		// unavailable or the lookup failed. Neither justifies a claim.
		expect(deviceVerification(null)).toBe("unknown");
		expect(deviceVerification(undefined)).toBe("unknown");
	});
});
