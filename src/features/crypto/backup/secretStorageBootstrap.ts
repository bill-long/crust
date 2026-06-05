import type { CreateSecretStorageOpts } from "matrix-js-sdk/lib/crypto-api";

/**
 * Build the options for `crypto.bootstrapSecretStorage` when setting up key
 * backup.
 *
 * Critically, `setupNewSecretStorage` is NEVER set. With it omitted the SDK
 * reuses existing secret storage and only invokes `createSecretStorageKey`
 * (which mints a new recovery key) when no storage exists yet. Forcing
 * `setupNewSecretStorage: true` made the SDK generate a brand-new recovery key
 * on every run — even when storage already existed — which re-keyed secret
 * storage and scattered secrets across multiple recovery keys (e.g.
 * cross-signing left under an old key while the backup key moved to a new one).
 *
 * `setupNewKeyBackup: true` is retained (pre-existing behavior): this flow sets
 * up a key backup. Making backup setup reuse an existing server-side backup
 * idempotently has subtle edge cases (a backup that exists but isn't active on
 * this device, an untrusted backup, or an uncertain "couldn't check" state) and
 * is tracked separately — see issue #207.
 */
export function secretStorageBootstrapOpts(
	createSecretStorageKey: CreateSecretStorageOpts["createSecretStorageKey"],
): CreateSecretStorageOpts {
	return {
		createSecretStorageKey,
		setupNewKeyBackup: true,
	};
}
