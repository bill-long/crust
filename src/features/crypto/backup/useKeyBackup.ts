import type { MatrixClient } from "matrix-js-sdk";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api";
import { type Accessor, createSignal, onCleanup } from "solid-js";

export interface KeyBackupProgress {
	/** Whether keys are actively being uploaded to the backup */
	isBackingUp: Accessor<boolean>;
	/** Number of sessions still waiting to be backed up */
	sessionsRemaining: Accessor<number>;
	/** Last backup error code, or null if none */
	lastError: Accessor<string | null>;
	/** Whether backup is enabled on this account */
	backupEnabled: Accessor<boolean>;
}

/**
 * Reactive hook tracking live key backup progress. Listens to
 * CryptoEvent.KeyBackupSessionsRemaining for upload progress,
 * CryptoEvent.KeyBackupFailed for errors, and CryptoEvent.KeyBackupStatus
 * for enabled/disabled state.
 *
 * Note: KeyBackupStatus indicates whether backup is enabled, not whether
 * an upload is in progress. Active upload is derived from sessionsRemaining > 0.
 */
export function useKeyBackup(client: MatrixClient): KeyBackupProgress {
	const [isBackingUp, setIsBackingUp] = createSignal(false);
	const [sessionsRemaining, setSessionsRemaining] = createSignal(0);
	const [lastError, setLastError] = createSignal<string | null>(null);
	const [backupEnabled, setBackupEnabled] = createSignal(false);

	const onBackupStatus = (enabled: boolean): void => {
		setBackupEnabled(enabled);
		if (!enabled) {
			setIsBackingUp(false);
			setSessionsRemaining(0);
		}
	};

	const onSessionsRemaining = (remaining: number): void => {
		setSessionsRemaining(remaining);
		if (remaining > 0) {
			setLastError(null);
			setIsBackingUp(true);
		} else {
			setIsBackingUp(false);
		}
	};

	const onBackupFailed = (errorCode: string): void => {
		setLastError(errorCode);
		setIsBackingUp(false);
	};

	client.on(CryptoEvent.KeyBackupStatus, onBackupStatus);
	client.on(CryptoEvent.KeyBackupSessionsRemaining, onSessionsRemaining);
	client.on(CryptoEvent.KeyBackupFailed, onBackupFailed);

	onCleanup(() => {
		client.removeListener(CryptoEvent.KeyBackupStatus, onBackupStatus);
		client.removeListener(
			CryptoEvent.KeyBackupSessionsRemaining,
			onSessionsRemaining,
		);
		client.removeListener(CryptoEvent.KeyBackupFailed, onBackupFailed);
	});

	return {
		isBackingUp,
		sessionsRemaining,
		lastError,
		backupEnabled,
	};
}
