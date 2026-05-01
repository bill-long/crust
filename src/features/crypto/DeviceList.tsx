import {
	type Component,
	createResource,
	For,
	Match,
	Show,
	Switch,
} from "solid-js";
import { useClient } from "../../client/client";
import DeviceItem, { type DeviceInfo } from "./DeviceItem";

interface DeviceListProps {
	onVerifyDevice?: (deviceId: string) => void;
}

/**
 * Lists all devices/sessions for the current user with their verification
 * status. Used in the cross-signing setup flow and settings.
 */
const DeviceList: Component<DeviceListProps> = (props) => {
	const { client } = useClient();

	const [devices] = createResource(async (): Promise<DeviceInfo[]> => {
		const crypto = client.getCrypto();
		const userId = client.getUserId();
		const currentDeviceId = client.getDeviceId();

		if (!userId) return [];

		// Fetch device list from server
		const response = await client.getDevices();
		if (!response?.devices) return [];

		// Get verification status for all devices in parallel
		const results = await Promise.all(
			response.devices.map(async (device): Promise<DeviceInfo> => {
				let isVerified = false;
				if (crypto && device.device_id) {
					try {
						const status = await crypto.getDeviceVerificationStatus(
							userId,
							device.device_id,
						);
						isVerified = status?.isVerified() ?? false;
					} catch {
						// Device may not have keys uploaded yet
					}
				}

				return {
					deviceId: device.device_id,
					displayName: device.display_name ?? "",
					lastSeenTs: device.last_seen_ts,
					isVerified,
					isCurrentDevice: device.device_id === currentDeviceId,
				};
			}),
		);

		// Sort: current device first, then by last seen (most recent first)
		results.sort((a, b) => {
			if (a.isCurrentDevice) return -1;
			if (b.isCurrentDevice) return 1;
			return (b.lastSeenTs ?? 0) - (a.lastSeenTs ?? 0);
		});

		return results;
	});

	return (
		<div class="space-y-2">
			<h3 class="text-sm font-medium text-neutral-300">Your devices</h3>
			<Switch>
				<Match when={devices.loading}>
					<div class="py-4 text-center text-sm text-neutral-500">
						Loading devices…
					</div>
				</Match>
				<Match when={devices.error}>
					<div class="py-4 text-center text-sm text-red-400">
						Failed to load devices
					</div>
				</Match>
				<Match when={devices()}>
					<div class="space-y-1">
						<For each={devices()}>
							{(device) => (
								<DeviceItem device={device} onVerify={props.onVerifyDevice} />
							)}
						</For>
					</div>
					<Show when={(devices()?.length ?? 0) === 0}>
						<div class="py-4 text-center text-sm text-neutral-500">
							No devices found
						</div>
					</Show>
				</Match>
			</Switch>
		</div>
	);
};

export default DeviceList;
