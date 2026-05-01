import type { Component } from "solid-js";
import { Match, Show, Switch } from "solid-js";
import type { KeyBackupProgress } from "./useKeyBackup";

interface BackupStatusProps {
	backup: KeyBackupProgress;
}

/**
 * Small inline indicator showing key backup health.
 * Shows backup progress, "up to date" state, or error.
 */
const BackupStatus: Component<BackupStatusProps> = (props) => {
	const b = props.backup;

	return (
		<Show when={b.backupEnabled()}>
			<div class="flex items-center gap-2 text-xs" role="status">
				<Switch>
					<Match when={b.lastError()}>
						<span class="text-red-400" role="img" aria-label="Error">
							⚠
						</span>
						<span class="text-red-300">Backup error</span>
					</Match>

					<Match when={b.isBackingUp()}>
						<span
							class="inline-block h-3 w-3 animate-spin rounded-full border border-neutral-600 border-t-green-400"
							role="img"
							aria-label="Uploading"
						/>
						<span class="text-neutral-400">
							Backing up… {b.sessionsRemaining()} remaining
						</span>
					</Match>

					<Match when={!b.isBackingUp()}>
						<span class="text-green-500" role="img" aria-label="Backed up">
							✓
						</span>
						<span class="text-neutral-500">Backup is up to date</span>
					</Match>
				</Switch>
			</div>
		</Show>
	);
};

export default BackupStatus;
