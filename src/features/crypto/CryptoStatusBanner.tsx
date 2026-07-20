import {
	type Component,
	createEffect,
	createSignal,
	lazy,
	onCleanup,
	Show,
	Suspense,
} from "solid-js";
import { useClient } from "../../client/client";
import {
	registerCryptoHandler,
	restoreCryptoTriggerFocus,
	setCryptoDialogOpen,
} from "../../stores/cryptoActions";
import type { CryptoAction } from "../../types/crypto";
import { RecoveryKeyInput } from "./backup/RecoveryKeyInput";
import { IncomingVerificationToast } from "./verification/IncomingVerificationToast";
import { useVerification } from "./verification/useVerification";

// Code splitting (#307): the crypto setup/verification/backup dialogs are
// opened only from the crypto banner or the Devices settings tab, so they
// load on demand. All four share the same outer box (fixed inset-0 z-50
// backdrop), so the shared Suspense fallback matches their dimensions and
// the swap causes no layout shift.
const CrossSigningSetup = lazy(() =>
	import("./CrossSigningSetup").then((m) => ({ default: m.CrossSigningSetup })),
);
const VerificationDialog = lazy(() =>
	import("./verification/VerificationDialog").then((m) => ({
		default: m.VerificationDialog,
	})),
);
const BackupSetupDialog = lazy(() =>
	import("./backup/BackupSetupDialog").then((m) => ({
		default: m.BackupSetupDialog,
	})),
);
const RecoveryKeyResetDialog = lazy(() =>
	import("./backup/RecoveryKeyResetDialog").then((m) => ({
		default: m.RecoveryKeyResetDialog,
	})),
);
const ResetEncryptionDialog = lazy(() =>
	import("./ResetEncryptionDialog").then((m) => ({
		default: m.ResetEncryptionDialog,
	})),
);

/**
 * Shared fallback matching the crypto dialogs' outer box. A component (not a
 * shared JSX const) so each Suspense boundary gets its own DOM node — Solid
 * reuses the node for a shared JSX reference, which would leave one fallback
 * empty if two dialogs ever rendered simultaneously.
 */
const CryptoDialogFallback: Component = () => (
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" />
);

/**
 * Global crypto overlays — modals, toasts, recovery key input.
 * Mount once at the app level. The UserBar in the sidebar triggers
 * crypto setup flows via registerCryptoHandler / triggerCryptoAction.
 */
const CryptoStatusBanner: Component = () => {
	const { client, cryptoStatus } = useClient();
	const [showSetup, setShowSetup] = createSignal(false);
	const [showVerification, setShowVerification] = createSignal(false);
	const [showBackupSetup, setShowBackupSetup] = createSignal(false);
	const [showRecoveryReset, setShowRecoveryReset] = createSignal(false);
	const [showEncryptionReset, setShowEncryptionReset] = createSignal(false);

	// Expose whether any crypto dialog is open (for inert on underlying content)
	createEffect(() => {
		setCryptoDialogOpen(
			showSetup() ||
				showVerification() ||
				showBackupSetup() ||
				showRecoveryReset() ||
				showEncryptionReset(),
		);
	});

	const verification = useVerification(client);

	const handleVerificationClose = (): void => {
		setShowVerification(false);
		cryptoStatus.refresh();
		restoreCryptoTriggerFocus();
	};

	// Register handler so the user panel can trigger crypto flows.
	// Clear stale state if the banner unmounts while a dialog is open
	onCleanup(() => {
		setCryptoDialogOpen(false);
		restoreCryptoTriggerFocus();
	});

	const unregister = registerCryptoHandler((a: CryptoAction) => {
		switch (a) {
			case "setup-cross-signing":
				setShowSetup(true);
				break;
			case "verify-session":
				verification.requestSelfVerification();
				setShowVerification(true);
				break;
			case "setup-backup":
			case "unlock-backup":
				// BackupSetupDialog detects an existing server backup and routes
				// to its unlock/restore path, so both actions land here.
				setShowBackupSetup(true);
				break;
			case "reset-recovery-key":
				setShowRecoveryReset(true);
				break;
			case "reset-encryption":
				setShowEncryptionReset(true);
				break;
		}
	});
	onCleanup(unregister);

	return (
		<>
			<Show when={showSetup()}>
				<Suspense fallback={<CryptoDialogFallback />}>
					<CrossSigningSetup
						onClose={() => {
							setShowSetup(false);
							restoreCryptoTriggerFocus();
						}}
					/>
				</Suspense>
			</Show>

			<Show when={showVerification()}>
				<Suspense fallback={<CryptoDialogFallback />}>
					<VerificationDialog
						verification={verification}
						onClose={handleVerificationClose}
					/>
				</Suspense>
			</Show>

			<Show when={showBackupSetup()}>
				<Suspense fallback={<CryptoDialogFallback />}>
					<BackupSetupDialog
						onClose={() => {
							setShowBackupSetup(false);
							cryptoStatus.refresh();
							restoreCryptoTriggerFocus();
						}}
					/>
				</Suspense>
			</Show>

			<Show when={showRecoveryReset()}>
				<Suspense fallback={<CryptoDialogFallback />}>
					<RecoveryKeyResetDialog
						onClose={() => {
							setShowRecoveryReset(false);
							cryptoStatus.refresh();
							restoreCryptoTriggerFocus();
						}}
					/>
				</Suspense>
			</Show>

			<Show when={showEncryptionReset()}>
				<Suspense fallback={<CryptoDialogFallback />}>
					<ResetEncryptionDialog
						onClose={() => {
							setShowEncryptionReset(false);
							cryptoStatus.refresh();
							restoreCryptoTriggerFocus();
						}}
					/>
				</Suspense>
			</Show>

			<RecoveryKeyInput />

			<IncomingVerificationToast
				client={client}
				onAccept={(request) => {
					verification.acceptIncoming(request);
					setShowVerification(true);
				}}
			/>
		</>
	);
};

export { CryptoStatusBanner };
