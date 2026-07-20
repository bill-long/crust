import type { MatrixClient } from "matrix-js-sdk";
import {
	type CrossSigningStatus,
	CryptoEvent,
	type DeviceVerificationStatus,
} from "matrix-js-sdk/lib/crypto-api";
import {
	type Accessor,
	batch,
	createEffect,
	createSignal,
	onCleanup,
} from "solid-js";
import { fetchServerKeyBackup } from "./backup/keyBackupSetup";

export interface CryptoStatus {
	/** Whether cross-signing keys are set up on this account */
	crossSigningReady: Accessor<boolean | undefined>;
	/**
	 * Whether this device is verified via cross-signing — i.e. signed by the
	 * account's CURRENT self-signing key. Deliberately NOT
	 * `DeviceVerificationStatus.isVerified()`: that also passes on
	 * `localVerified`, which is always true for the user's own device, so the
	 * badge stayed green after another client rotated the cross-signing
	 * identity (issue #420).
	 */
	thisDeviceVerified: Accessor<boolean | undefined>;
	/** Active key backup version, or null if none */
	backupVersion: Accessor<string | null | undefined>;
	/**
	 * Whether a key backup exists on the server, regardless of whether THIS
	 * session can use it. Distinguishes "no backup — set one up" from
	 * "backup exists but this session can't unlock it" (issue #420):
	 * `getActiveSessionBackupVersion()` is null in both cases.
	 */
	backupOnServer: Accessor<boolean | undefined>;
	/** Whether the key backup is trusted */
	backupTrusted: Accessor<boolean | undefined>;
	/** Whether secret storage is ready */
	secretStorageReady: Accessor<boolean | undefined>;
	/**
	 * Cross-signing key availability detail (public keys on server, private
	 * keys in secret storage / cached locally). Used to route "not ready"
	 * to either bootstrap (keys recoverable) or a full reset (identity
	 * exists but no accessible session holds it — issue #420).
	 */
	crossSigningStatus: Accessor<CrossSigningStatus | undefined>;
	/** Refresh all status values */
	refresh: () => Promise<void>;
}

/**
 * Reactive hook tracking E2EE status: cross-signing, device verification,
 * key backup, and secret storage. Polls once after sync is live, then
 * updates via CryptoEvent listeners.
 */
export function useCryptoStatus(
	client: MatrixClient,
	syncReady: Accessor<boolean>,
): CryptoStatus {
	const [crossSigningReady, setCrossSigningReady] = createSignal<
		boolean | undefined
	>(undefined);
	const [thisDeviceVerified, setThisDeviceVerified] = createSignal<
		boolean | undefined
	>(undefined);
	const [backupVersion, setBackupVersion] = createSignal<
		string | null | undefined
	>(undefined);
	const [backupOnServer, setBackupOnServer] = createSignal<boolean | undefined>(
		undefined,
	);
	const [backupTrusted, setBackupTrusted] = createSignal<boolean | undefined>(
		undefined,
	);
	const [secretStorageReady, setSecretStorageReady] = createSignal<
		boolean | undefined
	>(undefined);
	const [crossSigningStatus, setCrossSigningStatus] = createSignal<
		CrossSigningStatus | undefined
	>(undefined);

	// Version counter to prevent stale async results from overwriting newer ones
	let refreshVersion = 0;

	const refresh = async (): Promise<void> => {
		const crypto = client.getCrypto();
		if (!crypto) return;

		const thisVersion = ++refreshVersion;

		try {
			const [csReady, ssReady, bkVersion] = await Promise.all([
				crypto.isCrossSigningReady(),
				crypto.isSecretStorageReady(),
				crypto.getActiveSessionBackupVersion(),
			]);
			if (refreshVersion !== thisVersion) return;

			// Fetched separately: a transient failure here must not take down
			// the whole refresh — the rest of the status still applies, and an
			// undefined detail just keeps reset-vs-bootstrap routing unresolved.
			let csStatus: CrossSigningStatus | undefined;
			try {
				csStatus = await crypto.getCrossSigningStatus();
				if (refreshVersion !== thisVersion) return;
			} catch {
				if (refreshVersion !== thisVersion) return;
				csStatus = undefined;
			}

			// Check this device's verification status
			let deviceVerified = false;
			const userId = client.getUserId();
			const deviceId = client.getDeviceId();
			if (userId && deviceId) {
				try {
					const status: DeviceVerificationStatus | null =
						await crypto.getDeviceVerificationStatus(userId, deviceId);
					if (refreshVersion !== thisVersion) return;
					// Own device is always locally trusted, so isVerified() would
					// stay true even after the identity was rotated elsewhere.
					// crossSigningVerified only passes when the device is signed by
					// the current self-signing key (issue #420).
					deviceVerified = status?.crossSigningVerified ?? false;
				} catch {
					if (refreshVersion !== thisVersion) return;
				}
			}

			// Whether a backup exists on the server at all (distinct from this
			// session having it active). fetchServerKeyBackup throws on an
			// uncertain check; leave the signal undefined rather than guess.
			let bkOnServer: boolean | undefined;
			if (bkVersion) {
				bkOnServer = true;
			} else {
				try {
					bkOnServer = (await fetchServerKeyBackup(client)) !== null;
					if (refreshVersion !== thisVersion) return;
				} catch {
					if (refreshVersion !== thisVersion) return;
					bkOnServer = undefined;
				}
			}

			// Check backup trust if backup exists
			let bkTrusted: boolean | undefined;
			if (bkVersion) {
				try {
					const info = await crypto.getKeyBackupInfo();
					if (refreshVersion !== thisVersion) return;
					if (info) {
						const trust = await crypto.isKeyBackupTrusted(info);
						if (refreshVersion !== thisVersion) return;
						bkTrusted = trust.trusted;
					} else {
						bkTrusted = false;
					}
				} catch {
					if (refreshVersion !== thisVersion) return;
					bkTrusted = false;
				}
			}

			// Set all signals in a batch so dependents see one coherent update
			batch(() => {
				setCrossSigningReady(csReady);
				setSecretStorageReady(ssReady);
				setBackupVersion(bkVersion);
				setBackupOnServer(bkOnServer);
				setThisDeviceVerified(deviceVerified);
				setBackupTrusted(bkTrusted);
				setCrossSigningStatus(csStatus);
			});
		} catch (e) {
			console.error("Failed to refresh crypto status:", e);
		}
	};

	// Refresh when sync becomes ready
	createEffect(() => {
		if (syncReady()) {
			refresh();
		}
	});

	// Listen for crypto state changes
	const onKeysChanged = (): void => {
		refresh();
	};
	const onUserTrustChanged = (): void => {
		refresh();
	};
	const onDevicesUpdated = (): void => {
		refresh();
	};
	const onBackupStatus = (): void => {
		refresh();
	};
	const onBackupKeyCached = (): void => {
		refresh();
	};

	client.on(CryptoEvent.KeysChanged, onKeysChanged);
	client.on(CryptoEvent.UserTrustStatusChanged, onUserTrustChanged);
	client.on(CryptoEvent.DevicesUpdated, onDevicesUpdated);
	client.on(CryptoEvent.KeyBackupStatus, onBackupStatus);
	client.on(CryptoEvent.KeyBackupDecryptionKeyCached, onBackupKeyCached);

	onCleanup(() => {
		client.removeListener(CryptoEvent.KeysChanged, onKeysChanged);
		client.removeListener(
			CryptoEvent.UserTrustStatusChanged,
			onUserTrustChanged,
		);
		client.removeListener(CryptoEvent.DevicesUpdated, onDevicesUpdated);
		client.removeListener(CryptoEvent.KeyBackupStatus, onBackupStatus);
		client.removeListener(
			CryptoEvent.KeyBackupDecryptionKeyCached,
			onBackupKeyCached,
		);
	});

	return {
		crossSigningReady,
		thisDeviceVerified,
		backupVersion,
		backupOnServer,
		backupTrusted,
		secretStorageReady,
		crossSigningStatus,
		refresh,
	};
}
