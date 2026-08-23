import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	lazy,
	Match,
	onCleanup,
	Show,
	Suspense,
	Switch,
} from "solid-js";
import { useClient } from "../../client/client";
import { cryptoActionLabel, deriveCryptoAction } from "../../lib/cryptoAction";
import {
	acquireCryptoDialog,
	restoreCryptoTriggerFocus,
	setCryptoTriggerElement,
	triggerCryptoAction,
} from "../../stores/cryptoActions";
import { BackupStatus } from "../crypto/backup/BackupStatus";
import { DeviceList } from "../crypto/DeviceList";
import { SectionHeading } from "./SettingsControls";

// Lazy like the other crypto dialogs (#307): only loaded when the user
// actually opens the export/import flow from this tab.
const ExportKeysDialog = lazy(() =>
	import("../crypto/backup/ExportKeysDialog").then((m) => ({
		default: m.ExportKeysDialog,
	})),
);
const ImportKeysDialog = lazy(() =>
	import("../crypto/backup/ImportKeysDialog").then((m) => ({
		default: m.ImportKeysDialog,
	})),
);

const StatusBadge: Component<{ ok: boolean; label: string }> = (props) => (
	<span
		class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
		classList={{
			"bg-success-bg text-success-text": props.ok,
			"bg-warning-bg text-warning-text": !props.ok,
		}}
	>
		<span aria-hidden="true">{props.ok ? "\u2713" : "\u26A0"}</span>
		{props.label}
	</span>
);

const ActionButton: Component<{
	label: string;
	danger?: boolean;
	onClick: () => void;
}> = (props) => (
	<button
		type="button"
		onClick={props.onClick}
		class="rounded px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
		classList={{
			"bg-accent text-accent-foreground hover:bg-accent-hover": !props.danger,
			"bg-danger text-danger-foreground hover:bg-danger/90": !!props.danger,
		}}
	>
		{props.label}
	</button>
);

const DialogFallback: Component = () => (
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" />
);

/**
 * Card fallback while a status signal is undefined. With crypto in the
 * error state the signals are guaranteed never to resolve, so "Loading…"
 * would spin forever (issue #480) - say what is actually the case instead.
 * (A transient refresh failure with crypto up can also pass through here as
 * "Loading…"; those re-resolve on the next CryptoEvent-driven refresh.)
 */
const StatusPending: Component<{ cryptoFailed: boolean }> = (props) => (
	<span class="text-xs text-text-disabled">
		{props.cryptoFailed ? "Unavailable" : "Loading…"}
	</span>
);

const DevicesTab: Component = () => {
	const { client, cryptoState, cryptoStatus } = useClient();

	const [showExportKeys, setShowExportKeys] = createSignal(false);
	const [showImportKeys, setShowImportKeys] = createSignal(false);
	// Hold the shared crypto-dialog-open flag while the export or import
	// dialog is open, so inert gating of underlying content also covers
	// dialogs launched from the Devices tab.
	createEffect(() => {
		if (!showExportKeys() && !showImportKeys()) return;
		const release = acquireCryptoDialog();
		onCleanup(release);
	});

	const cryptoAction = createMemo(() =>
		deriveCryptoAction({
			crossSigningReady: cryptoStatus.crossSigningReady(),
			thisDeviceVerified: cryptoStatus.thisDeviceVerified(),
			backupVersion: cryptoStatus.backupVersion(),
			backupOnServer: cryptoStatus.backupOnServer(),
			crossSigningStatus: cryptoStatus.crossSigningStatus(),
		}),
	);

	const actionLabel = createMemo(() => cryptoActionLabel(cryptoAction()));

	// The account has a cross-signing identity, but this session isn't
	// trusted with it yet (a fresh login, or one whose trust was lost when
	// the identity was rotated elsewhere).
	const identityUnavailableHere = (): boolean =>
		cryptoStatus.crossSigningReady() === false &&
		cryptoStatus.crossSigningStatus()?.publicKeysOnDevice === true;

	// "Not set up" is a definitive claim that needs the cross-signing detail:
	// without it, not-ready could equally be an identity this session can't
	// see yet, and deriveCryptoAction treats that snapshot as loading.
	const crossSigningResolved = (): boolean =>
		cryptoStatus.crossSigningReady() === true ||
		(cryptoStatus.crossSigningReady() === false &&
			cryptoStatus.crossSigningStatus() !== undefined);

	const needsAttention = () => {
		const a = cryptoAction();
		return (
			a === "setup-cross-signing" ||
			a === "verify-session" ||
			a === "setup-backup" ||
			a === "unlock-backup" ||
			a === "reset-encryption"
		);
	};

	const handleAction = (): void => {
		const action = cryptoAction();
		if (action !== "hidden" && action !== "loading") {
			triggerCryptoAction(action);
		}
	};

	return (
		<div class="space-y-8">
			{/* Encryption overview */}
			<section>
				<SectionHeading>Encryption</SectionHeading>

				{/* The app-level warning banner sends the user here when crypto
				    init fails, so this panel must say so rather than sit on
				    "Loading…" forever with no action (issue #480). */}
				<Show when={cryptoState() === "error"}>
					<div class="mb-4 flex items-center justify-between gap-3 rounded-lg border border-warning-border bg-warning-bg/50 px-4 py-3">
						<div class="text-sm text-warning-text">
							Encryption failed to initialize in this session, so its status
							can't be checked and verification isn't available. Reload the app
							to retry; if it keeps failing, log out and back in.
						</div>
						<ActionButton label="Reload" onClick={() => location.reload()} />
					</div>
				</Show>

				{/* Action banner */}
				<Show when={needsAttention()}>
					<button
						type="button"
						onClick={handleAction}
						class="mb-4 flex w-full items-center gap-3 rounded-lg bg-warning-bg/60 px-4 py-3 text-left text-sm text-warning-text-bright transition-colors hover:bg-warning-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
					>
						<span class="text-base" aria-hidden="true">
							{"\u26A0"}
						</span>
						<span>{actionLabel()}</span>
					</button>
				</Show>

				<div class="space-y-3">
					{/* Cross-signing */}
					<div class="flex items-center justify-between rounded-lg bg-surface-2/50 px-4 py-3">
						<div>
							<div class="text-sm font-medium text-text-primary">
								Cross-signing
							</div>
							<div class="text-xs text-text-muted">
								{/* Only when verifying is the way forward: an identity with
								    no reachable keys is also "unavailable" but needs a reset,
								    and telling that user to enter a recovery key would be
								    wrong. */}
								<Switch fallback="Verify your identity across devices">
									<Match
										when={
											identityUnavailableHere() &&
											cryptoAction() === "verify-session"
										}
									>
										Set up on your account but not available to this session —
										verify it or enter your recovery key.
									</Match>
									<Match
										when={
											identityUnavailableHere() &&
											cryptoAction() === "reset-encryption"
										}
									>
										Set up on your account, but this session can't reach its
										keys — from here it can only be reset.
									</Match>
								</Switch>
							</div>
						</div>
						<Show
							when={crossSigningResolved()}
							fallback={
								<StatusPending cryptoFailed={cryptoState() === "error"} />
							}
						>
							<div class="flex items-center gap-2">
								{/* Three states, not two: an identity that exists on the
								    account but that this session can't use is "unavailable",
								    the same distinction the Key backup card draws — calling it
								    "not set up" points the user at setup instead of
								    verification (issue #480). */}
								<StatusBadge
									ok={cryptoStatus.crossSigningReady() === true}
									label={
										cryptoStatus.crossSigningReady()
											? "Ready"
											: identityUnavailableHere()
												? "Unavailable"
												: "Not set up"
									}
								/>
								{/* An identity that exists but is unreachable from every
								    session can only be replaced; anything else is a normal
								    bootstrap (issue #420). */}
								<Show when={cryptoAction() === "reset-encryption"}>
									<ActionButton
										label="Reset…"
										danger
										onClick={() => triggerCryptoAction("reset-encryption")}
									/>
								</Show>
								<Show when={cryptoAction() === "setup-cross-signing"}>
									<ActionButton
										label="Set up"
										onClick={() => triggerCryptoAction("setup-cross-signing")}
									/>
								</Show>
							</div>
						</Show>
					</div>

					{/* Session verification */}
					<div class="flex items-center justify-between rounded-lg bg-surface-2/50 px-4 py-3">
						<div>
							<div class="text-sm font-medium text-text-primary">
								Session verification
							</div>
							<div class="text-xs text-text-muted">
								Confirm this device is trusted
							</div>
						</div>
						<Show
							when={cryptoStatus.thisDeviceVerified() !== undefined}
							fallback={
								<StatusPending cryptoFailed={cryptoState() === "error"} />
							}
						>
							<div class="flex items-center gap-2">
								<StatusBadge
									ok={cryptoStatus.thisDeviceVerified() === true}
									label={
										cryptoStatus.thisDeviceVerified()
											? "Verified"
											: "Unverified"
									}
								/>
								{/* Offered whenever verifying is the derived action — which
								    includes a session that can't use the account's identity
								    yet, not only one where cross-signing is already ready
								    (issue #480). */}
								<Show
									when={
										cryptoAction() === "verify-session" &&
										cryptoStatus.thisDeviceVerified() === false
									}
								>
									<ActionButton
										label="Verify"
										onClick={() => triggerCryptoAction("verify-session")}
									/>
								</Show>
							</div>
						</Show>
					</div>

					{/* Key backup */}
					<div class="flex items-center justify-between rounded-lg bg-surface-2/50 px-4 py-3">
						<div>
							<div class="text-sm font-medium text-text-primary">
								Key backup
							</div>
							<div class="text-xs text-text-muted">
								<Show
									when={
										cryptoStatus.backupVersion() === null &&
										cryptoStatus.backupOnServer() === true
									}
									fallback="Encrypted message history recovery"
								>
									Backup exists but unavailable to this session — verify or
									enter recovery key.
								</Show>
							</div>
						</div>
						<Show
							when={cryptoStatus.backupVersion() !== undefined}
							fallback={
								<StatusPending cryptoFailed={cryptoState() === "error"} />
							}
						>
							<div class="flex items-center gap-2">
								<Show
									when={cryptoStatus.backupVersion()}
									fallback={
										<>
											{/* A backup can exist on the server while this session
											    has no access to its decryption key — offer "unlock"
											    rather than a misleading "set up" (issue #420). */}
											<Show
												when={cryptoStatus.backupOnServer() === true}
												fallback={
													<Show
														when={cryptoStatus.backupOnServer() === false}
														fallback={
															<span class="text-xs text-text-disabled">
																Checking…
															</span>
														}
													>
														<StatusBadge ok={false} label="Not set up" />
														<ActionButton
															label="Set up"
															onClick={() =>
																triggerCryptoAction("setup-backup")
															}
														/>
													</Show>
												}
											>
												<StatusBadge ok={false} label="Unavailable" />
												<ActionButton
													label="Unlock…"
													onClick={() => triggerCryptoAction("unlock-backup")}
												/>
											</Show>
										</>
									}
								>
									<BackupStatus client={client} />
								</Show>
							</div>
						</Show>
					</div>

					{/* Offline key export / import */}
					<div class="flex items-center justify-between rounded-lg bg-surface-2/50 px-4 py-3">
						<div>
							<div class="text-sm font-medium text-text-primary">
								Message key export
							</div>
							<div class="text-xs text-text-muted">
								Offline backup of this device's message keys
							</div>
						</div>
						<div class="flex items-center gap-2">
							<ActionButton
								label="Export…"
								onClick={() => {
									setCryptoTriggerElement(document.activeElement);
									setShowExportKeys(true);
								}}
							/>
							<ActionButton
								label="Import…"
								onClick={() => {
									setCryptoTriggerElement(document.activeElement);
									setShowImportKeys(true);
								}}
							/>
						</div>
					</div>
				</div>

				{/* Reset recovery key (advanced) — repairs split secret storage */}
				<Show when={cryptoStatus.crossSigningReady() === true}>
					<div class="mt-4 flex items-center justify-between gap-3 rounded-lg border border-border-subtle px-4 py-3">
						<div class="min-w-0">
							<div class="text-sm font-medium text-text-primary">
								Reset recovery key
							</div>
							<div class="text-xs text-text-muted">
								Replace your recovery key with a single new one (e.g. if you
								have more than one). Other sessions stay verified.
							</div>
						</div>
						<button
							type="button"
							onClick={() => triggerCryptoAction("reset-recovery-key")}
							class="shrink-0 rounded bg-surface-3 px-2.5 py-1 text-xs font-medium text-text-primary transition-colors hover:bg-surface-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
						>
							Reset…
						</button>
					</div>
				</Show>
			</section>

			{/* Devices */}
			<section>
				<DeviceList
					onVerifyDevice={(deviceId) =>
						triggerCryptoAction({ action: "verify-device", deviceId })
					}
				/>
			</section>

			<Show when={showExportKeys()}>
				<Suspense fallback={<DialogFallback />}>
					<ExportKeysDialog
						onClose={() => {
							setShowExportKeys(false);
							restoreCryptoTriggerFocus();
						}}
					/>
				</Suspense>
			</Show>
			<Show when={showImportKeys()}>
				<Suspense fallback={<DialogFallback />}>
					<ImportKeysDialog
						onClose={() => {
							setShowImportKeys(false);
							restoreCryptoTriggerFocus();
						}}
					/>
				</Suspense>
			</Show>
		</div>
	);
};

export { DevicesTab };
