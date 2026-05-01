import type { MatrixClient } from "matrix-js-sdk";
import {
	CryptoEvent,
	type DeviceVerificationStatus,
} from "matrix-js-sdk/lib/crypto-api";
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";

export interface CryptoStatus {
	/** Whether cross-signing keys are set up on this account */
	crossSigningReady: Accessor<boolean | undefined>;
	/** Whether this device is cross-signing verified */
	thisDeviceVerified: Accessor<boolean | undefined>;
	/** Active key backup version, or null if none */
	backupVersion: Accessor<string | null | undefined>;
	/** Whether the key backup is trusted */
	backupTrusted: Accessor<boolean | undefined>;
	/** Whether secret storage is ready */
	secretStorageReady: Accessor<boolean | undefined>;
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
	const [backupTrusted, setBackupTrusted] = createSignal<boolean | undefined>(
		undefined,
	);
	const [secretStorageReady, setSecretStorageReady] = createSignal<
		boolean | undefined
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

			// Discard if a newer refresh started while we were awaiting
			if (refreshVersion !== thisVersion) return;

			setCrossSigningReady(csReady);
			setSecretStorageReady(ssReady);
			setBackupVersion(bkVersion);

			// Check this device's verification status
			const userId = client.getUserId();
			const deviceId = client.getDeviceId();
			if (userId && deviceId) {
				try {
					const status: DeviceVerificationStatus | null =
						await crypto.getDeviceVerificationStatus(userId, deviceId);
					if (refreshVersion !== thisVersion) return;
					setThisDeviceVerified(status?.isVerified() ?? false);
				} catch {
					if (refreshVersion !== thisVersion) return;
					setThisDeviceVerified(false);
				}
			}

			// Check backup trust if backup exists
			if (bkVersion) {
				const info = await crypto.getKeyBackupInfo();
				if (refreshVersion !== thisVersion) return;
				if (info) {
					const trust = await crypto.isKeyBackupTrusted(info);
					if (refreshVersion !== thisVersion) return;
					setBackupTrusted(trust.trusted);
				} else {
					setBackupTrusted(false);
				}
			} else {
				setBackupTrusted(undefined);
			}
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
		backupTrusted,
		secretStorageReady,
		refresh,
	};
}
