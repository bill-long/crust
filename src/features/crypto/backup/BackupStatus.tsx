import type { MatrixClient } from "matrix-js-sdk";
import type { Component } from "solid-js";
import { Match, Switch } from "solid-js";
import { useKeyBackup } from "./useKeyBackup";

interface BackupStatusProps {
	client: MatrixClient;
}

/**
 * Small inline indicator showing key backup health.
 * Shows backup progress, "up to date" state, or error.
 *
 * Owns the key-backup progress hook internally so callers only need to
 * supply the client - keeping useKeyBackup private to the crypto feature.
 *
 * Parent component is responsible for gating visibility (e.g., only
 * rendering when backup version exists). This component always renders
 * its content — it does not gate on backupEnabled because that signal
 * is event-driven and won't be true on initial mount.
 */
const BackupStatus: Component<BackupStatusProps> = (props) => {
	const b = useKeyBackup(props.client);

	return (
		<div class="flex items-center gap-2 text-xs" role="status">
			<Switch>
				<Match when={b.lastError()}>
					<span class="text-danger-text" role="img" aria-label="Error">
						⚠
					</span>
					<span class="text-danger-text-bright">Backup error</span>
				</Match>

				<Match when={b.isBackingUp()}>
					<span
						class="inline-block h-3 w-3 animate-spin rounded-full border border-border-strong border-t-success-text"
						role="img"
						aria-label="Uploading"
					/>
					<span class="text-text-muted">
						Backing up… {b.sessionsRemaining()} remaining
					</span>
				</Match>

				<Match when={!b.isBackingUp()}>
					<span class="text-success-text" role="img" aria-label="Backed up">
						✓
					</span>
					<span class="text-text-disabled">Backup is up to date</span>
				</Match>
			</Switch>
		</div>
	);
};

export { BackupStatus };
