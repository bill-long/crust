import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api";
import {
	type Component,
	createResource,
	For,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { useClient } from "../../client/client";
import { fetchDeviceVerification } from "../../lib/deviceVerification";
import { type DeviceInfo, DeviceItem } from "./DeviceItem";

interface DeviceListProps {
	onVerifyDevice?: (deviceId: string) => void;
}

/**
 * Lists all devices/sessions for the current user with their verification
 * status. Used in the cross-signing setup flow and settings.
 */
const DeviceList: Component<DeviceListProps> = (props) => {
	const { client } = useClient();

	const [devices, { refetch }] = createResource(
		async (): Promise<DeviceInfo[]> => {
			const crypto = client.getCrypto();
			const userId = client.getUserId();
			const currentDeviceId = client.getDeviceId();

			if (!userId) return [];

			// Fetch device list from server
			const response = await client.getDevices();
			if (!response?.devices) return [];

			// Get verification status for all devices in parallel. The badge is
			// derived through the one shared rule (src/lib/deviceVerification.ts):
			// no crypto, a failed lookup, or a device the SDK holds no keys for
			// renders as unknown, not as a confident "unverified" (issue #480).
			const results = await Promise.all(
				response.devices.map(
					async (device): Promise<DeviceInfo> => ({
						deviceId: device.device_id,
						displayName: device.display_name ?? "",
						lastSeenTs: device.last_seen_ts,
						// A device the server reports without an id can't be looked
						// up - that is an unknown, stated rather than thrown into.
						verification: device.device_id
							? await fetchDeviceVerification(crypto, userId, device.device_id)
							: "unknown",
						isCurrentDevice: device.device_id === currentDeviceId,
					}),
				),
			);

			// Sort: current device first, then by last seen (most recent first)
			results.sort((a, b) => {
				if (a.isCurrentDevice) return -1;
				if (b.isCurrentDevice) return 1;
				return (b.lastSeenTs ?? 0) - (a.lastSeenTs ?? 0);
			});

			return results;
		},
	);

	// Refetch device list when crypto state changes (e.g. after verification
	// or cross-signing setup). Coalesce rapid bursts via microtask.
	let refetchQueued = false;
	const triggerRefetch = (): void => {
		if (refetchQueued) return;
		refetchQueued = true;
		queueMicrotask(() => {
			refetchQueued = false;
			void refetch();
		});
	};

	const currentUserId = client.getUserId();

	const onUserTrustChanged = (changedUserId: string): void => {
		if (changedUserId === currentUserId) triggerRefetch();
	};
	const onDevicesUpdated = (users: string[]): void => {
		if (currentUserId && users.includes(currentUserId)) triggerRefetch();
	};
	const onKeysChanged = (): void => {
		triggerRefetch();
	};

	client.on(CryptoEvent.UserTrustStatusChanged, onUserTrustChanged);
	client.on(CryptoEvent.DevicesUpdated, onDevicesUpdated);
	client.on(CryptoEvent.KeysChanged, onKeysChanged);

	onCleanup(() => {
		client.removeListener(
			CryptoEvent.UserTrustStatusChanged,
			onUserTrustChanged,
		);
		client.removeListener(CryptoEvent.DevicesUpdated, onDevicesUpdated);
		client.removeListener(CryptoEvent.KeysChanged, onKeysChanged);
	});

	return (
		<div class="space-y-2">
			<h3 class="text-sm font-medium text-text-secondary">Your devices</h3>
			<Switch>
				<Match when={devices.loading}>
					<div class="py-4 text-center text-sm text-text-disabled">
						Loading devices…
					</div>
				</Match>
				<Match when={devices.error}>
					<div class="py-4 text-center text-sm text-danger-text">
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
						<div class="py-4 text-center text-sm text-text-disabled">
							No devices found
						</div>
					</Show>
				</Match>
			</Switch>
		</div>
	);
};

export { DeviceList };
