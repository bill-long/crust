import type { CryptoApi } from "matrix-js-sdk/lib/crypto-api";

type VerifyWithRecoveryKeyCrypto = Pick<
	CryptoApi,
	| "getCrossSigningStatus"
	| "bootstrapCrossSigning"
	| "getDeviceVerificationStatus"
	| "crossSignDevice"
>;

/**
 * Verify this session with the recovery key instead of from another
 * session: import the account's cross-signing private keys from secret
 * storage (the SDK prompts for the recovery key through the registered
 * resolver) and sign this device with them.
 *
 * Runs only when the private keys are in secret storage. The SDK's bootstrap
 * has no "import only" mode - when it finds no keys anywhere it creates a NEW
 * identity, which would orphan every other session - so the status check
 * below is the guard: bootstrap re-reads the same secrets moments later, and
 * only their deletion in between could reach its reset branch. The upload
 * callback handed to bootstrap refuses as a last line, so even then no
 * replacement identity is published (the SDK rotates local keys and rewrites
 * secret storage before it uploads, so that path would still need a reset to
 * repair - hence the check, not the callback, carries the safety).
 *
 * @throws when the keys are not in secret storage, the recovery-key prompt is
 *   cancelled, or the key is wrong - the caller shows the message.
 */
export async function verifySessionWithRecoveryKey(
	crypto: VerifyWithRecoveryKeyCrypto,
	userId: string,
	deviceId: string,
): Promise<void> {
	const status = await crypto.getCrossSigningStatus();
	if (!status.privateKeysInSecretStorage) {
		throw new Error(
			"The cross-signing keys are not in secret storage, so the recovery key can't verify this session. Verify from another session instead.",
		);
	}

	await crypto.bootstrapCrossSigning({
		// Only reachable on bootstrap's reset branch, which the check above
		// makes all but unreachable; see the doc comment.
		authUploadDeviceSigningKeys: async () => {
			throw new Error(
				"Refusing to replace the account's cross-signing identity: its private keys are no longer in secret storage.",
			);
		},
	});

	// Bootstrap signs this device only on its import-from-secret-storage
	// path; if the keys were already cached locally it leaves the device as
	// it found it, so sign explicitly rather than report a verification that
	// did not happen.
	const verification = await crypto.getDeviceVerificationStatus(
		userId,
		deviceId,
	);
	if (!verification?.crossSigningVerified) {
		await crypto.crossSignDevice(deviceId);
	}
}
