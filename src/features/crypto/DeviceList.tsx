import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api";
import {
	type Component,
	createResource,
	createSignal,
	For,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import {
	ACCOUNT_MANAGEMENT_ACTIONS,
	type AccountManagement,
	accountManagementDeeplink,
	fetchAccountManagement,
} from "../../client/accountManagement";
import { useClient } from "../../client/client";
import { fetchDeviceVerification } from "../../lib/deviceVerification";
import { loadSession } from "../../stores/session";
import { type DeviceInfo, DeviceItem, SIGN_OUT_ATTR } from "./DeviceItem";
import { SignOutDeviceDialog } from "./SignOutDeviceDialog";

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

	// --- Signing another session out (#556) ---

	// OIDC sessions can't complete classic UIA on the management routes -
	// the server refuses them outright (#451), which is cinnyapp/cinny#2376.
	// Their sign-out happens at the account portal instead. Session type
	// can't change without a full re-login, so one read at mount is enough
	// (same rule AccountTab applies to password/deactivate).
	const viaPortal = loadSession()?.oidc !== undefined;

	const [signOutTarget, setSignOutTarget] = createSignal<DeviceInfo | null>(
		null,
	);

	// Fetched only once a sign-out is actually started: getAuthMetadata is a
	// real round-trip with no SDK-side cache, and most visits to this tab
	// never revoke anything. Cached for the life of the list so opening a
	// second dialog costs nothing.
	let managementRequest: Promise<AccountManagement | null> | null = null;

	// Carries the device id it was resolved FOR: createResource keeps the
	// previous value while refetching, so a dialog opened for a second
	// device would otherwise render the first device's deeplink for a tick -
	// and this link's whole job is to name one exact device.
	const [portal] = createResource(signOutTarget, async (target: DeviceInfo) => {
		managementRequest = managementRequest ?? fetchAccountManagement(client);
		const mgmt = await managementRequest;
		return {
			deviceId: target.deviceId,
			url:
				mgmt &&
				accountManagementDeeplink(
					mgmt,
					ACCOUNT_MANAGEMENT_ACTIONS.deviceDelete,
					{ deviceId: target.deviceId },
				),
		};
	});

	// undefined while the lookup for THIS device is still in flight (which
	// includes the window where the resource still holds the previous
	// device's value), null/string once it has resolved for this one.
	const portalUrlFor = (deviceId: string): string | null | undefined => {
		const resolved = portal();
		return resolved?.deviceId === deviceId ? resolved.url : undefined;
	};

	// Focus restoration, deliberately local rather than the shared
	// setCryptoTriggerElement/restoreCryptoTriggerFocus pair. Two reasons:
	// that pair captures document.activeElement, which is only the row's
	// button if the click focused it; and on the SUCCESS path the row is
	// gone (we just revoked it), where the helper can only no-op - leaving
	// focus on <body>, and SettingsOverlay binds its Escape and Tab
	// handling to its own root, so both silently stop working there.
	//
	// Look the row up by id instead, and fall back to the list when it has
	// been revoked away, so the keyboard always stays inside the overlay.
	let listEl!: HTMLDivElement;

	const closeSignOut = (): void => {
		const deviceId = signOutTarget()?.deviceId;
		setSignOutTarget(null);
		// Matched by reading the attribute rather than interpolating the id
		// into a selector: device ids come from the server, so a selector
		// would need CSS.escape - which is absent in some environments (the
		// unit suite's jsdom among them) and would throw here, silently
		// stranding focus on <body>, the exact failure this exists to stop.
		const row = deviceId
			? Array.from(
					listEl.querySelectorAll<HTMLElement>(`[${SIGN_OUT_ATTR}]`),
				).find((el) => el.getAttribute(SIGN_OUT_ATTR) === deviceId)
			: undefined;
		(row ?? listEl).focus();
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
		// tabIndex -1 so it can take focus when the row that opened the
		// sign-out dialog is gone by the time the dialog closes.
		<div class="space-y-2" ref={listEl} tabIndex={-1}>
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
								<DeviceItem
									device={device}
									onVerify={props.onVerifyDevice}
									onSignOut={() => setSignOutTarget(device)}
								/>
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

			{/* Keyed so a different device always gets a fresh dialog: the
			    dialog builds its UIA flow (and its device-pinned deeplink) at
			    mount, and an unkeyed Show would swap the props underneath a
			    flow still bound to the previous device. */}
			<Show when={signOutTarget()} keyed>
				{(target) => (
					<SignOutDeviceDialog
						deviceId={target.deviceId}
						deviceName={target.displayName || target.deviceId}
						viaPortal={viaPortal}
						portalUrl={portalUrlFor(target.deviceId)}
						onClose={closeSignOut}
						onSignedOut={() => {
							void refetch();
						}}
					/>
				)}
			</Show>
		</div>
	);
};

export { DeviceList };
