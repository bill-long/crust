import type { CrossSigningStatus } from "matrix-js-sdk/lib/crypto-api";
import type { CryptoAction } from "../types/crypto";

export interface CryptoActionInput {
	crossSigningReady: boolean | undefined;
	thisDeviceVerified: boolean | undefined;
	backupVersion: string | null | undefined;
	/** Whether a backup exists on the server, even if this session can't use it. */
	backupOnServer: boolean | undefined;
	/** Cross-signing key availability detail (reset-vs-bootstrap routing). */
	crossSigningStatus: CrossSigningStatus | undefined;
}

/**
 * Decide which encryption action (if any) the user should be pointed at,
 * from the crypto status snapshot. Shared by the status banner, the
 * Devices & Security tab, and the user-panel warning dot.
 */
export function deriveCryptoAction(input: CryptoActionInput): CryptoAction {
	const {
		crossSigningReady,
		thisDeviceVerified,
		backupVersion,
		backupOnServer,
		crossSigningStatus,
	} = input;
	if (crossSigningReady === undefined || thisDeviceVerified === undefined)
		return "loading";
	if (!crossSigningReady) {
		// Routing matters here (issue #420): when an identity exists on the
		// server but no private keys are reachable (not local, not in secret
		// storage), plain bootstrap fails against the existing identity — the
		// only way forward from this device is a full reset. When the private
		// keys ARE reachable, nothing destructive is needed: the in-4S case is
		// a verification (below), and locally cached keys let the ordinary
		// setup flow reuse them. Fail toward the non-destructive flows
		// whenever any private key source exists.
		if (crossSigningStatus === undefined) return "loading";
		const identityExists = crossSigningStatus.publicKeysOnDevice;
		const cached = crossSigningStatus.privateKeysCachedLocally;
		const inSecretStorage = crossSigningStatus.privateKeysInSecretStorage;
		const recoverable =
			inSecretStorage ||
			(cached.masterKey && cached.selfSigningKey && cached.userSigningKey);
		if (identityExists && !recoverable) return "reset-encryption";
		// The account already has an identity and its private keys are in
		// secret storage: nothing needs setting up, this session just isn't
		// trusted yet. The way forward is to verify it - from another session
		// or with the recovery key - and offering "set up" here sends the
		// user at the wrong affordance (issue #480).
		if (identityExists && inSecretStorage) return "verify-session";
		return "setup-cross-signing";
	}
	if (thisDeviceVerified === false) return "verify-session";
	if (backupVersion === null) {
		// A backup can exist on the server while this session has no access
		// to its decryption key — that's an unlock, not a setup (issue #420).
		// While the server probe is unresolved, offering either would be a
		// guess: stay in loading like the Devices tab's "Checking…" state.
		if (backupOnServer === undefined) return "loading";
		return backupOnServer ? "unlock-backup" : "setup-backup";
	}
	return "hidden";
}

/** Label for crypto action shown in the user panel tooltip. */
export function cryptoActionLabel(action: CryptoAction): string {
	switch (action) {
		case "setup-cross-signing":
			return "Set up secure messaging";
		case "verify-session":
			return "Verify this session";
		case "setup-backup":
			return "Set up key backup";
		case "unlock-backup":
			return "Unlock key backup";
		case "reset-encryption":
			return "Reset encryption";
		default:
			return "";
	}
}
