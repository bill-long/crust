import type {
	CreateSecretStorageOpts,
	CryptoApi,
} from "matrix-js-sdk/lib/crypto-api";

/**
 * Whether each secret needed to consolidate secret storage is available
 * *locally* on this device.
 */
export interface ConsolidationReadiness {
	/** All three cross-signing private keys are cached locally on this device. */
	crossSigningLocal: boolean;
	/**
	 * Either there is no server-side key backup, or the existing backup matches
	 * the backup decryption key held locally on this device.
	 */
	backupKeyLocal: boolean;
}

/**
 * Whether it is SAFE to consolidate secret storage under a single new recovery
 * key.
 *
 * Re-keying secret storage (`bootstrapSecretStorage` with
 * `setupNewSecretStorage: true`) re-encrypts only the secrets the device holds
 * locally. If the cross-signing private keys or the backup decryption key are
 * NOT available locally (e.g. they live only in old, differently-keyed secret
 * storage), re-keying would orphan them under a key the user no longer has.
 * So we require local possession of every secret before allowing a reset.
 *
 * Note: `isCrossSigningReady()` / `isSecretStorageReady()` are NOT sufficient
 * gates — they can report ready when the private keys are only in old secret
 * storage, not cached locally.
 */
export function canConsolidateRecoveryKey(r: ConsolidationReadiness): boolean {
	return r.crossSigningLocal && r.backupKeyLocal;
}

/** Gather local-possession readiness for a recovery-key consolidation. */
export async function getConsolidationReadiness(
	crypto: Pick<
		CryptoApi,
		"getCrossSigningStatus" | "getKeyBackupInfo" | "isKeyBackupTrusted"
	>,
): Promise<ConsolidationReadiness> {
	const cs = await crypto.getCrossSigningStatus();
	const crossSigningLocal = Boolean(
		cs.privateKeysCachedLocally.masterKey &&
			cs.privateKeysCachedLocally.selfSigningKey &&
			cs.privateKeysCachedLocally.userSigningKey,
	);

	// Gate on server-side backup EXISTENCE (getKeyBackupInfo), not this
	// session's active state (getActiveSessionBackupVersion). A backup can
	// exist on the server with its decryption key only in old, differently-keyed
	// secret storage (not cached locally) — getActiveSessionBackupVersion would
	// return null there and wrongly let the reset orphan the backup key.
	const info = await crypto.getKeyBackupInfo();
	let backupKeyLocal = true;
	if (info) {
		const trust = await crypto.isKeyBackupTrusted(info);
		backupKeyLocal = trust.matchesDecryptionKey === true;
	}

	return { crossSigningLocal, backupKeyLocal };
}

/**
 * Options for `crypto.bootstrapSecretStorage` when deliberately resetting the
 * recovery key (consolidating split secret storage under one new key).
 *
 * `setupNewSecretStorage: true` forces a new recovery key and re-encrypts the
 * locally-held secrets (cross-signing keys + backup key) under it. Unlike the
 * routine backup-setup flow, this reset INTENTIONALLY sets the flag.
 *
 * `setupNewKeyBackup` is omitted so the existing key-backup VERSION is
 * preserved (the backup key is re-stored under the new recovery key, not
 * replaced) and cross-signing identity is untouched — other sessions stay
 * verified.
 */
export function secretStorageResetOpts(
	createSecretStorageKey: NonNullable<
		CreateSecretStorageOpts["createSecretStorageKey"]
	>,
): CreateSecretStorageOpts {
	return {
		createSecretStorageKey,
		setupNewSecretStorage: true,
	};
}
