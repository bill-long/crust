import type { MatrixClient } from "matrix-js-sdk";
import { ClientPrefix, MatrixError, Method } from "matrix-js-sdk";
import type {
	CreateSecretStorageOpts,
	CryptoApi,
	KeyBackupInfo,
} from "matrix-js-sdk/lib/crypto-api";

type BackupHttpClient = { http: Pick<MatrixClient["http"], "authedRequest"> };

/**
 * Definitively determine whether a server-side key backup exists, distinguishing
 * "none" from "couldn't check".
 *
 * `CryptoApi.getKeyBackupInfo()` coerces a transient server failure to `null`,
 * making it indistinguishable from "no backup" — relying on it risks a
 * destructive reset when the server is merely unreachable. This queries
 * `GET /room_keys/version` directly (mirroring the SDK's own
 * `requestKeyBackupVersion`): a `M_NOT_FOUND` (404) is the only signal treated
 * as "no backup"; every other error propagates so callers abort rather than
 * supersede an existing backup.
 */
export async function fetchServerKeyBackup(
	client: BackupHttpClient,
): Promise<KeyBackupInfo | null> {
	try {
		return await client.http.authedRequest<KeyBackupInfo>(
			Method.Get,
			"/room_keys/version",
			undefined,
			undefined,
			{ prefix: ClientPrefix.V3 },
		);
	} catch (e) {
		if (
			e instanceof MatrixError &&
			e.httpStatus === 404 &&
			e.errcode === "M_NOT_FOUND"
		) {
			return null;
		}
		throw e;
	}
}

/**
 * Outcome of {@link ensureKeyBackup}.
 * - `created` — no server backup existed, so a new one was minted and is active.
 * - `reused` — an existing server backup was found and is active on this session.
 * - `needs-restore` — a backup exists but isn't active on this device (its
 *   decryption key isn't available locally); the user must restore/unlock it.
 */
export type EnsureKeyBackupResult =
	| { outcome: "created" }
	| { outcome: "reused" }
	| { outcome: "needs-restore" };

type EnsureKeyBackupCrypto = Pick<
	CryptoApi,
	| "bootstrapSecretStorage"
	| "checkKeyBackupAndEnable"
	| "getActiveSessionBackupVersion"
>;

/**
 * Idempotently ensure a key backup is set up, without ever superseding an
 * existing one.
 *
 * Forcing `setupNewKeyBackup: true` on every run makes the SDK call
 * `resetKeyBackup`, which deletes and replaces any existing server-side backup
 * (orphaning the message keys archived under it). Instead we detect an existing
 * backup first (via `detectExistingBackup`, which must throw — not return null —
 * on an uncertain check) and only request a new one when the server genuinely
 * has none.
 *
 * Success is never reported until `getActiveSessionBackupVersion()` confirms the
 * backup is actually active; a backup that exists but can't be activated on this
 * device yields `needs-restore` so the user can unlock it.
 */
export async function ensureKeyBackup(
	crypto: EnsureKeyBackupCrypto,
	createSecretStorageKey: NonNullable<
		CreateSecretStorageOpts["createSecretStorageKey"]
	>,
	detectExistingBackup: () => Promise<KeyBackupInfo | null>,
): Promise<EnsureKeyBackupResult> {
	const existingBackup = await detectExistingBackup();

	await crypto.bootstrapSecretStorage({
		createSecretStorageKey,
		setupNewKeyBackup: !existingBackup,
	});

	// Drive backup activation to completion before judging success. When a new
	// backup is created, the SDK's resetKeyBackup() fires checkKeyBackupAndEnable()
	// WITHOUT awaiting it ("check and start async"), so the active version may not
	// be set yet; for an existing backup, bootstrap only stores the key. Awaiting
	// it here makes the active-version check below deterministic.
	await crypto.checkKeyBackupAndEnable();

	// Only claim success once the backup is genuinely active on this session.
	// With `setupNewKeyBackup: false`, the SDK connects to an existing backup
	// only when its decryption key is available; on a fresh device the backup
	// stays inactive until the user unlocks it with their recovery key.
	const activeVersion = await crypto.getActiveSessionBackupVersion();
	if (activeVersion === null) {
		return { outcome: "needs-restore" };
	}
	return existingBackup ? { outcome: "reused" } : { outcome: "created" };
}

type ActivateKeyBackupCrypto = Pick<
	CryptoApi,
	| "loadSessionBackupPrivateKeyFromSecretStorage"
	| "checkKeyBackupAndEnable"
	| "getActiveSessionBackupVersion"
>;

/**
 * Connect this device to an existing-but-inactive key backup by loading its
 * decryption key from secret storage (which prompts for the recovery key via
 * the registered resolver) and enabling the backup.
 *
 * @returns `true` if the backup is active afterwards.
 */
export async function activateExistingKeyBackup(
	crypto: ActivateKeyBackupCrypto,
): Promise<boolean> {
	await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
	await crypto.checkKeyBackupAndEnable();
	const activeVersion = await crypto.getActiveSessionBackupVersion();
	return activeVersion !== null;
}
