import type { MatrixClient } from "matrix-js-sdk";
import { type CryptoApi, CryptoEvent } from "matrix-js-sdk/lib/crypto-api";

type VerifyWithRecoveryKeyCrypto = Pick<
	CryptoApi,
	"getCrossSigningStatus" | "bootstrapCrossSigning" | "crossSignDevice"
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
	deviceId: string,
): Promise<void> {
	const status = await crypto.getCrossSigningStatus();
	if (!status.privateKeysInSecretStorage) {
		throw new Error(
			"The cross-signing keys are not in secret storage, so the recovery key can't verify this session. Verify from another session instead.",
		);
	}
	const cached = status.privateKeysCachedLocally;
	const keysAlreadyCached =
		cached.masterKey && cached.selfSigningKey && cached.userSigningKey;

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
	// path; when the keys were already cached locally it leaves the device as
	// it found it, so sign explicitly rather than report a verification that
	// did not happen. Decided from the status read above, not by asking the
	// SDK afterwards: the device's own signature list is only refreshed by
	// the next /keys/query, so right after bootstrap it still reads as
	// unsigned either way.
	if (keysAlreadyCached) {
		await crypto.crossSignDevice(deviceId);
	}
}

/**
 * Wait for the next device-list refresh of `userId`'s devices, bounded.
 *
 * The SDK only updates a device's own signature list from `/keys/query`, so
 * right after the signature upload above this device still reads as
 * unsigned. The upload marks the device list changed, so a query follows
 * with the next sync; waiting for it (up to `timeoutMs`) lets the caller
 * refresh to the verified state before reporting success, instead of closing
 * onto a card that still says Unverified. Updates for other users are
 * ignored - they would release the wait before our signature is visible.
 * Resolves on timeout too: the status hook re-runs on the same event, so the
 * card heals on its own either way.
 */
export function waitForDevicesUpdated(
	client: Pick<MatrixClient, "on" | "removeListener">,
	userId: string,
	timeoutMs: number,
): Promise<void> {
	return new Promise((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			client.removeListener(CryptoEvent.DevicesUpdated, onUpdated);
			resolve();
		};
		const onUpdated = (users: string[]): void => {
			if (users.includes(userId)) done();
		};
		const timer = setTimeout(done, timeoutMs);
		client.on(CryptoEvent.DevicesUpdated, onUpdated);
	});
}
