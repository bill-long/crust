import { type Component, Show } from "solid-js";

export interface DeviceInfo {
	deviceId: string;
	displayName: string;
	lastSeenTs: number | undefined;
	isVerified: boolean;
	isCurrentDevice: boolean;
}

interface DeviceItemProps {
	device: DeviceInfo;
	onVerify?: (deviceId: string) => void;
}

function formatLastSeen(ts: number | undefined): string {
	if (!ts) return "Unknown";
	const date = new Date(ts);
	const now = Date.now();
	const diffMs = now - ts;
	const diffMins = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMs / 3_600_000);
	const diffDays = Math.floor(diffMs / 86_400_000);

	if (diffMins < 1) return "Just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return date.toLocaleDateString();
}

const DeviceItem: Component<DeviceItemProps> = (props) => {
	return (
		<div class="flex items-center justify-between rounded-lg bg-neutral-800/50 px-4 py-3">
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<span class="truncate text-sm font-medium text-white">
						{props.device.displayName || props.device.deviceId}
					</span>
					<Show when={props.device.isCurrentDevice}>
						<span class="shrink-0 rounded bg-neutral-700 px-1.5 py-0.5 text-xs text-neutral-300">
							This device
						</span>
					</Show>
				</div>
				<div class="mt-0.5 flex items-center gap-2 text-xs text-neutral-500">
					<span class="truncate">{props.device.deviceId}</span>
					<span>·</span>
					<span>{formatLastSeen(props.device.lastSeenTs)}</span>
				</div>
			</div>

			<div class="ml-3 flex shrink-0 items-center gap-2">
				<Show
					when={props.device.isVerified}
					fallback={
						<>
							<span class="text-amber-400" role="img" aria-label="Unverified">
								⚠
							</span>
							<Show when={!props.device.isCurrentDevice && props.onVerify}>
								<button
									type="button"
									onClick={() => props.onVerify?.(props.device.deviceId)}
									class="rounded bg-neutral-700 px-2 py-1 text-xs text-white transition-colors hover:bg-neutral-600"
								>
									Verify
								</button>
							</Show>
						</>
					}
				>
					<span class="text-green-400" aria-hidden="true">
						✓
					</span>
					<span class="text-xs text-green-400">Verified</span>
				</Show>
			</div>
		</div>
	);
};

export default DeviceItem;
