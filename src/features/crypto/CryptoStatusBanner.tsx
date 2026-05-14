import {
	type Component,
	createEffect,
	createSignal,
	onCleanup,
	Show,
} from "solid-js";
import { useClient } from "../../client/client";
import {
	registerCryptoHandler,
	restoreCryptoTriggerFocus,
	setCryptoDialogOpen,
} from "../../stores/cryptoActions";
import type { CryptoAction } from "../../types/crypto";
import { BackupSetupDialog } from "./backup/BackupSetupDialog";
import { RecoveryKeyInput } from "./backup/RecoveryKeyInput";
import { CrossSigningSetup } from "./CrossSigningSetup";
import { IncomingVerificationToast } from "./verification/IncomingVerificationToast";
import { useVerification } from "./verification/useVerification";
import { VerificationDialog } from "./verification/VerificationDialog";

export function deriveCryptoAction(
	crossSigningReady: boolean | undefined,
	thisDeviceVerified: boolean | undefined,
	backupVersion: string | null | undefined,
): CryptoAction {
	if (crossSigningReady === undefined || thisDeviceVerified === undefined)
		return "loading";
	if (!crossSigningReady) return "setup-cross-signing";
	if (thisDeviceVerified === false) return "verify-session";
	if (backupVersion === null) return "setup-backup";
	return "hidden";
}

/** Label for crypto action shown in the user panel tooltip. */
export function cryptoActionLabel(action: CryptoAction): string {
	switch (action) {
		case "setup-cross-signing":
			return "Set up secure messaging";
		case "verify-session":
			return "Verify this session";
		case "setup-backup":
			return "Set up key backup";
		default:
			return "";
	}
}

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

	// Expose whether any crypto dialog is open (for inert on underlying content)
	createEffect(() => {
		setCryptoDialogOpen(showSetup() || showVerification() || showBackupSetup());
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
				setShowBackupSetup(true);
				break;
		}
	});
	onCleanup(unregister);

	return (
		<>
			<Show when={showSetup()}>
				<CrossSigningSetup
					onClose={() => {
						setShowSetup(false);
						restoreCryptoTriggerFocus();
					}}
				/>
			</Show>

			<Show when={showVerification()}>
				<VerificationDialog
					verification={verification}
					onClose={handleVerificationClose}
				/>
			</Show>

			<Show when={showBackupSetup()}>
				<BackupSetupDialog
					onClose={() => {
						setShowBackupSetup(false);
						cryptoStatus.refresh();
						restoreCryptoTriggerFocus();
					}}
				/>
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
