import { type Component, createMemo, Show } from "solid-js";
import { useClient } from "../../client/client";
import { triggerCryptoAction } from "../../stores/cryptoActions";
import { BackupStatus } from "../crypto/backup/BackupStatus";
import { useKeyBackup } from "../crypto/backup/useKeyBackup";
import {
	cryptoActionLabel,
	deriveCryptoAction,
} from "../crypto/CryptoStatusBanner";
import { DeviceList } from "../crypto/DeviceList";
import { SectionHeading } from "./SettingsControls";

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

const DevicesTab: Component = () => {
	const { client, cryptoStatus } = useClient();
	const backup = useKeyBackup(client);

	const cryptoAction = createMemo(() =>
		deriveCryptoAction(
			cryptoStatus.crossSigningReady(),
			cryptoStatus.thisDeviceVerified(),
			cryptoStatus.backupVersion(),
		),
	);

	const actionLabel = createMemo(() => cryptoActionLabel(cryptoAction()));

	const needsAttention = () => {
		const a = cryptoAction();
		return (
			a === "setup-cross-signing" ||
			a === "verify-session" ||
			a === "setup-backup"
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
								Verify your identity across devices
							</div>
						</div>
						<Show
							when={cryptoStatus.crossSigningReady() !== undefined}
							fallback={
								<span class="text-xs text-text-disabled">Loading…</span>
							}
						>
							<div class="flex items-center gap-2">
								<StatusBadge
									ok={cryptoStatus.crossSigningReady() === true}
									label={
										cryptoStatus.crossSigningReady() ? "Ready" : "Not set up"
									}
								/>
								<Show when={cryptoStatus.crossSigningReady() === false}>
									<button
										type="button"
										onClick={() => triggerCryptoAction("setup-cross-signing")}
										class="rounded bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									>
										Set up
									</button>
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
								<span class="text-xs text-text-disabled">Loading…</span>
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
								<Show
									when={
										cryptoStatus.crossSigningReady() === true &&
										cryptoStatus.thisDeviceVerified() === false
									}
								>
									<button
										type="button"
										onClick={() => triggerCryptoAction("verify-session")}
										class="rounded bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
									>
										Verify
									</button>
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
								Encrypted message history recovery
							</div>
						</div>
						<Show
							when={cryptoStatus.backupVersion() !== undefined}
							fallback={
								<span class="text-xs text-text-disabled">Loading…</span>
							}
						>
							<div class="flex items-center gap-2">
								<Show
									when={cryptoStatus.backupVersion()}
									fallback={
										<>
											<StatusBadge ok={false} label="Not set up" />
											<button
												type="button"
												onClick={() => triggerCryptoAction("setup-backup")}
												class="rounded bg-accent px-2.5 py-1 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
											>
												Set up
											</button>
										</>
									}
								>
									<BackupStatus backup={backup} />
								</Show>
							</div>
						</Show>
					</div>
				</div>
			</section>

			{/* Devices */}
			<section>
				<SectionHeading>Your Devices</SectionHeading>
				<DeviceList />
			</section>
		</div>
	);
};

export { DevicesTab };
