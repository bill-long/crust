import {
	type Component,
	createMemo,
	createSignal,
	Match,
	Show,
	Switch,
} from "solid-js";
import { useClient } from "../../client/client";
import BackupSetupDialog from "./backup/BackupSetupDialog";
import BackupStatus from "./backup/BackupStatus";
import RecoveryKeyInput from "./backup/RecoveryKeyInput";
import { useKeyBackup } from "./backup/useKeyBackup";
import { CrossSigningSetup } from "./CrossSigningSetup";
import IncomingVerificationToast from "./verification/IncomingVerificationToast";
import { useVerification } from "./verification/useVerification";
import VerificationDialog from "./verification/VerificationDialog";

type BannerState =
	| "loading"
	| "setup-cross-signing"
	| "verify-session"
	| "setup-backup"
	| "hidden";

function deriveBannerState(
	crossSigningReady: boolean | undefined,
	thisDeviceVerified: boolean | undefined,
	backupVersion: string | null | undefined,
): BannerState {
	if (crossSigningReady === undefined || thisDeviceVerified === undefined)
		return "loading";
	if (!crossSigningReady) return "setup-cross-signing";
	if (thisDeviceVerified === false) return "verify-session";
	if (backupVersion === null) return "setup-backup";
	return "hidden";
}

const CryptoStatusBanner: Component = () => {
	const { client, cryptoStatus } = useClient();
	const [showSetup, setShowSetup] = createSignal(false);
	const [showVerification, setShowVerification] = createSignal(false);
	const [showBackupSetup, setShowBackupSetup] = createSignal(false);

	const verification = useVerification(client);
	const backupProgress = useKeyBackup(client);

	const bannerState = createMemo(
		(): BannerState =>
			deriveBannerState(
				cryptoStatus.crossSigningReady(),
				cryptoStatus.thisDeviceVerified(),
				cryptoStatus.backupVersion(),
			),
	);

	const startSelfVerification = (): void => {
		verification.requestSelfVerification();
		setShowVerification(true);
	};

	const handleVerificationClose = (): void => {
		setShowVerification(false);
		cryptoStatus.refresh();
	};

	return (
		<>
			<Show when={bannerState() !== "hidden" && bannerState() !== "loading"}>
				<div
					class="flex items-center justify-between border-b border-amber-800/50 bg-amber-950/40 px-4 py-2"
					role="status"
				>
					<Switch>
						<Match when={bannerState() === "setup-cross-signing"}>
							<div class="flex items-center gap-2">
								<span class="text-amber-400" role="img" aria-label="Warning">
									⚠
								</span>
								<span class="text-sm text-amber-200">
									Set up secure messaging to verify your devices and protect
									your messages.
								</span>
							</div>
							<button
								type="button"
								onClick={() => setShowSetup(true)}
								class="shrink-0 rounded bg-amber-700 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-amber-600"
							>
								Set up
							</button>
						</Match>

						<Match when={bannerState() === "verify-session"}>
							<div class="flex items-center gap-2">
								<span class="text-amber-400" role="img" aria-label="Warning">
									⚠
								</span>
								<span class="text-sm text-amber-200">
									Verify this session to access encrypted messages from your
									other devices.
								</span>
							</div>
							<button
								type="button"
								onClick={startSelfVerification}
								class="shrink-0 rounded bg-amber-700 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-amber-600"
							>
								Verify
							</button>
						</Match>

						<Match when={bannerState() === "setup-backup"}>
							<div class="flex items-center gap-2">
								<span class="text-amber-400" role="img" aria-label="Warning">
									⚠
								</span>
								<span class="text-sm text-amber-200">
									Set up key backup to protect your message history.
								</span>
							</div>
							<button
								type="button"
								onClick={() => setShowBackupSetup(true)}
								class="shrink-0 rounded bg-amber-700 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-amber-600"
							>
								Set up backup
							</button>
						</Match>
					</Switch>
				</div>
			</Show>

			<Show when={showSetup()}>
				<CrossSigningSetup onClose={() => setShowSetup(false)} />
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
					}}
				/>
			</Show>

			<Show
				when={
					bannerState() === "hidden" && cryptoStatus.backupVersion() != null
				}
			>
				<BackupStatus backup={backupProgress} />
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

export default CryptoStatusBanner;
