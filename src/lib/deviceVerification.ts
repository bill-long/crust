import type { DeviceVerificationStatus } from "matrix-js-sdk/lib/crypto-api";

export type DeviceVerification = "verified" | "unverified" | "unknown";

/**
 * THE rule for what UI may claim about one of the user's own devices
 * (issue #480). Every surface that renders a verified/unverified badge for
 * an own device derives it from here; nothing else may interpret a
 * DeviceVerificationStatus.
 *
 * - "verified" means cross-signed by the account's CURRENT self-signing
 *   key. `isVerified()` is deliberately not used: it also passes on
 *   `localVerified`, which is always true for the user's own device and
 *   survives an identity rotation elsewhere, so it would keep calling a
 *   device verified that the rest of the account no longer trusts
 *   (issue #420).
 * - No status - crypto unavailable, the lookup threw, or the SDK returned
 *   null because it holds no keys for the device - is "unknown", never a
 *   confident "unverified": reporting false on a transient failure
 *   misroutes the UI and slanders a device that may be fine.
 */
export function deviceVerification(
	status: DeviceVerificationStatus | null | undefined,
): DeviceVerification {
	if (!status) return "unknown";
	return status.crossSigningVerified ? "verified" : "unverified";
}
