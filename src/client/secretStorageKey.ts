/**
 * Secret-storage (4S) key selection for the crypto `getSecretStorageKey`
 * callback.
 *
 * The SDK calls the callback with the set of secret-storage keys IT knows
 * about, but that set is a snapshot: account data can change after the
 * snapshot was taken — e.g. another client re-keys 4S ("Change recovery
 * key") while this session's prompt is still open. Validating the user's
 * entry against the stale snapshot rejects the *genuine current* recovery
 * key ("Incorrect recovery key" for the right key — see issue #420).
 *
 * `resolveSecretStorageKey` therefore prefers the freshest data available:
 * the account's current default key description fetched straight from the
 * server, falling back to the SDK's offered set only when the fresh fetch
 * is missing or unusable. It is resolved at validation time (when the user
 * submits), not when the prompt is created, so a key change that happens
 * while the dialog is open is picked up.
 */

import type { SecretStorageKeyDescription } from "matrix-js-sdk/lib/secret-storage";

export interface SecretStorageKeyChoice {
	keyId: string;
	keyInfo: SecretStorageKeyDescription;
}

export interface SecretStorageKeySource {
	/** Keys the SDK currently knows about (its possibly-stale snapshot). */
	offeredKeys: Record<string, SecretStorageKeyDescription>;
	/** The account's current default key id, or null when none is set. */
	getDefaultKeyId: () => Promise<string | null>;
	/**
	 * Fetch the freshest key description for a key id (straight from account
	 * data on the server). Returns null when the key event doesn't exist or
	 * can't be read.
	 */
	fetchKeyInfo: (keyId: string) => Promise<SecretStorageKeyDescription | null>;
}

/**
 * Whether a key description can actually validate a recovery key. A
 * tombstoned `m.secret_storage.key.*` event (empty content, left behind
 * when another client wiped secret storage) is not usable, and neither is
 * a description without the iv/mac check values for aes-hmac-sha2.
 */
function isUsableKeyDescription(
	info: SecretStorageKeyDescription | null,
): info is SecretStorageKeyDescription {
	if (!info) return false;
	if (info.algorithm === "m.secret_storage.v1.aes-hmac-sha2") {
		return typeof info.iv === "string" && typeof info.mac === "string";
	}
	// Unknown/passphrase-only descriptions can't validate a raw recovery key.
	return false;
}

/**
 * Whether a cached (already validated) secret-storage key may be reused for
 * a new SDK request without re-prompting.
 *
 * The SDK calls getSecretStorageKey several times within one operation
 * (e.g. bootstrapCrossSigning), each time with the key set it currently
 * knows about. When validation resolved a key that is NOT in that set —
 * exactly the stale-snapshot case resolveSecretStorageKey exists for —
 * membership alone would force a second prompt for the same operation.
 * The cached key was validated against `cachedKeyId`'s description, so it
 * is also safe to reuse when that id is still the account's default key.
 */
export function canReuseCachedSecretStorageKey(
	cachedKeyId: string,
	offeredKeys: Record<string, unknown>,
	defaultKeyId: string | null,
): boolean {
	return cachedKeyId in offeredKeys || cachedKeyId === defaultKeyId;
}

/**
 * Pick the secret-storage key to validate a recovery key against.
 *
 * Preference order:
 *  1. The account's default key, using a freshly fetched description
 *     (correct even when the SDK's offered set is stale).
 *  2. The account's default key, using the SDK's offered description.
 *  3. The first offered key (no usable default — the SDK knows best).
 *  4. null when there are no keys at all.
 */
export async function resolveSecretStorageKey(
	source: SecretStorageKeySource,
): Promise<SecretStorageKeyChoice | null> {
	const defaultKeyId = await source.getDefaultKeyId();
	if (defaultKeyId) {
		try {
			const fresh = await source.fetchKeyInfo(defaultKeyId);
			if (isUsableKeyDescription(fresh)) {
				return { keyId: defaultKeyId, keyInfo: fresh };
			}
		} catch {
			// Fresh fetch failed — fall through to the offered set.
		}
		const offeredDefault = source.offeredKeys[defaultKeyId];
		if (isUsableKeyDescription(offeredDefault ?? null)) {
			return { keyId: defaultKeyId, keyInfo: offeredDefault };
		}
	}

	const firstOfferedId = Object.keys(source.offeredKeys)[0];
	if (firstOfferedId) {
		return {
			keyId: firstOfferedId,
			keyInfo: source.offeredKeys[firstOfferedId],
		};
	}
	return null;
}
