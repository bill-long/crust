import { type Component, Match, Show, Switch } from "solid-js";
import { Tooltip } from "../../components/Tooltip";
import type { DeviceVerification } from "../../lib/deviceVerification";
import { formatRelativeTime } from "../../lib/relativeTime";

export interface DeviceInfo {
	deviceId: string;
	displayName: string;
	lastSeenTs: number | undefined;
	verification: DeviceVerification;
	isCurrentDevice: boolean;
}

interface DeviceItemProps {
	device: DeviceInfo;
	onVerify?: (deviceId: string) => void;
}

function formatLastSeen(ts: number | undefined): string {
	if (!ts) return "Unknown";
	const label = formatRelativeTime(ts, Date.now());
	// Sentence position: "Just now" rather than "just now".
	return label.charAt(0).toUpperCase() + label.slice(1);
}

const DeviceItem: Component<DeviceItemProps> = (props) => {
	const unverifiedExplanation = (): string =>
		props.device.isCurrentDevice
			? "This session hasn't been verified. Verify it from another signed-in session so its messages can be cryptographically trusted."
			: "This session hasn't been verified — its messages can't be cryptographically trusted. Verify it to confirm it belongs to you.";

	return (
		<div class="flex items-center justify-between rounded-lg bg-surface-2/50 px-4 py-3">
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<span class="truncate text-sm font-medium text-text-primary">
						{props.device.displayName || props.device.deviceId}
					</span>
					<Show when={props.device.isCurrentDevice}>
						<span class="shrink-0 rounded bg-surface-3 px-1.5 py-0.5 text-xs text-text-secondary">
							This device
						</span>
					</Show>
				</div>
				<div class="mt-0.5 flex items-center gap-2 text-xs text-text-disabled">
					<span class="truncate">{props.device.deviceId}</span>
					<span>·</span>
					<span>{formatLastSeen(props.device.lastSeenTs)}</span>
				</div>
			</div>

			<div class="ml-3 flex shrink-0 items-center gap-2">
				<Switch>
					<Match when={props.device.verification === "verified"}>
						<span class="text-success-text" aria-hidden="true">
							✓
						</span>
						<span class="text-xs text-success-text">Verified</span>
					</Match>
					{/* No claim either way: crypto is unavailable, the lookup
					    failed, or the SDK holds no keys for this device. Rendering
					    this as "Unverified" was issue #480 - and with no working
					    crypto there is nothing a Verify button could do. */}
					<Match when={props.device.verification === "unknown"}>
						<Tooltip
							content="Verification status unavailable: encryption isn't working in this session, the check failed, or this device has no encryption keys."
							triggerTabIndex={0}
						>
							<span class="flex items-center gap-1 text-text-disabled">
								<span aria-hidden="true">?</span>
								{/* Not plain "Unknown": the last-seen column already renders
								    that for a missing timestamp, and two bare Unknowns in one
								    row read as noise. */}
								<span class="text-xs">Status unknown</span>
							</span>
						</Tooltip>
					</Match>
					<Match when={props.device.verification === "unverified"}>
						<Tooltip content={unverifiedExplanation()} triggerTabIndex={0}>
							<span class="flex items-center gap-1 text-warning-text">
								<span aria-hidden="true">⚠</span>
								<span class="text-xs">Unverified</span>
							</span>
						</Tooltip>
						<Show
							when={!props.device.isCurrentDevice && props.onVerify}
							fallback={
								<Show when={props.device.isCurrentDevice}>
									<span class="text-xs text-text-secondary">
										Verify from another session
									</span>
								</Show>
							}
						>
							<button
								type="button"
								onClick={() => props.onVerify?.(props.device.deviceId)}
								class="rounded bg-surface-3 px-2 py-1 text-xs text-text-primary transition-colors hover:bg-surface-4 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
							>
								Verify
							</button>
						</Show>
					</Match>
				</Switch>
			</div>
		</div>
	);
};

export { DeviceItem };
