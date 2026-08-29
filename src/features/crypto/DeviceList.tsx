import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api";
import {
	type Component,
	createMemo,
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
import {
	type DeviceInfo,
	DeviceItem,
	deviceLabel,
	SIGN_OUT_ATTR,
} from "./DeviceItem";
import {
	SignOutSessionsDialog,
	type SignOutTarget,
} from "./SignOutSessionsDialog";

/**
 * Identity of what a sign-out dialog was opened for, so the deeplink
 * resource can tell "resolved for this target" from "still holding the
 * previous one's value". The whole `others` set shares one key: its link
 * is the account portal's session list, which does not vary with the set.
 */
const targetKey = (target: SignOutTarget): string =>
	target.kind === "device" ? `device:${target.deviceId}` : "others";

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

	const [signOutTarget, setSignOutTarget] = createSignal<SignOutTarget | null>(
		null,
	);

	/**
	 * Every session but this one - what the bulk control revokes, and what
	 * its count names. Empty whenever the list is loading or failed, so
	 * "there is something to sign out" is decided in one place and the
	 * control is never offered over a set the rows below it aren't showing.
	 *
	 * A device the server reported without an id is left out: there is
	 * nothing to put in the request for it, so promising to sign it out
	 * would be a promise the request cannot keep. It stays visible in the
	 * list afterwards rather than silently counted as gone.
	 */
	// The order of the reads is the whole point. A Solid memo is EAGER: it
	// re-runs on every state change of the resource whether or not anything
	// reads it, so no short-circuit at the use site can protect it - the
	// guard has to be inside. And both ways of reading the value are
	// hazardous from in here:
	//   - `devices()` suspends the nearest boundary, which for this
	//     component is the <Suspense> around the whole lazy settings
	//     overlay (`Layout`). Solid DETACHES a suspended subtree, so a
	//     refetch would rip the settings pane out of the document and put
	//     it back ~200ms later, taking focus with it.
	//   - `devices.latest` is that same suspending read until the resource
	//     first resolves, and rethrows a settled error after - which would
	//     turn a failed `GET /devices` into an exception escaping the
	//     component instead of the "Failed to load devices" row below.
	// `devices.loading` and `devices.error` do neither, so they come first
	// and `.latest` is only reached once it is a plain settled value.
	const otherDevices = createMemo(() =>
		devices.loading || devices.error
			? []
			: (devices.latest?.filter((d) => !d.isCurrentDevice && d.deviceId) ?? []),
	);

	// Fetched only once a sign-out is actually started: getAuthMetadata is a
	// real round-trip with no SDK-side cache, and most visits to this tab
	// never revoke anything. Cached for the life of the list so opening a
	// second dialog costs nothing.
	let managementRequest: Promise<AccountManagement | null> | null = null;

	// Carries the target it was resolved FOR: createResource keeps the
	// previous value while refetching, so a dialog opened for a second
	// target would otherwise render the first one's deeplink for a tick -
	// and this link's whole job is to name exactly what is being revoked.
	const [portal] = createResource(
		signOutTarget,
		async (target: SignOutTarget) => {
			managementRequest = managementRequest ?? fetchAccountManagement(client);
			const mgmt = await managementRequest;
			return {
				key: targetKey(target),
				url:
					mgmt &&
					(target.kind === "device"
						? accountManagementDeeplink(
								mgmt,
								ACCOUNT_MANAGEMENT_ACTIONS.deviceDelete,
								{ deviceId: target.deviceId },
							)
						: accountManagementDeeplink(
								mgmt,
								ACCOUNT_MANAGEMENT_ACTIONS.devicesList,
							)),
			};
		},
	);

	// undefined while the lookup for THIS target is still in flight (which
	// includes the window where the resource still holds the previous
	// target's value), null/string once it has resolved for this one.
	const portalUrlFor = (target: SignOutTarget): string | null | undefined => {
		const resolved = portal();
		return resolved?.key === targetKey(target) ? resolved.url : undefined;
	};

	// Focus restoration, deliberately local rather than the shared
	// setCryptoTriggerElement/restoreCryptoTriggerFocus pair. Two reasons:
	// that pair captures document.activeElement, which is only the row's
	// button if the click focused it; and on the SUCCESS path the row is
	// gone (we just revoked it), where the helper can only no-op - leaving
	// focus on <body>, and SettingsOverlay binds its Escape and Tab
	// handling to its own root, so both silently stop working there.
	//
	// Look the control up instead, and fall back to the list when it has
	// been revoked away, so the keyboard always stays inside the overlay.
	let listEl!: HTMLDivElement;
	let signOutAllEl: HTMLButtonElement | undefined;

	// Set when the dialog reports a completed revoke, and read by the close
	// that immediately follows. The refetch that revoke starts has NOT
	// resolved at that moment, so the control that opened the dialog is
	// still in the document and looks perfectly focusable - then the
	// refetch removes it a tick later and focus silently lands on <body>,
	// outside the overlay whose root owns Escape and Tab. Nothing
	// observable at close time distinguishes a doomed trigger from a live
	// one, so the success itself has to say so. (Found in the running app.
	// The window is the same for one row as for the whole set.)
	let revoked = false;

	/** The control that opened this target's dialog, when it is still in
	 *  the document and is going to stay there. */
	const triggerFor = (target: SignOutTarget): HTMLElement | undefined => {
		if (revoked) return undefined;
		if (target.kind === "others") {
			// Also gone when a row sign-out left this session as the only
			// one. A detached node is not an error to focus() - it silently
			// does nothing and leaves focus on <body> - so check, don't
			// assume.
			return signOutAllEl?.isConnected ? signOutAllEl : undefined;
		}
		// Matched by reading the attribute rather than interpolating the id
		// into a selector: device ids come from the server, so a selector
		// would need CSS.escape - which is absent in some environments (the
		// unit suite's jsdom among them) and would throw here, silently
		// stranding focus on <body>, the exact failure this exists to stop.
		return Array.from(
			listEl.querySelectorAll<HTMLElement>(`[${SIGN_OUT_ATTR}]`),
		).find((el) => el.getAttribute(SIGN_OUT_ATTR) === target.deviceId);
	};

	const closeSignOut = (): void => {
		const target = signOutTarget();
		setSignOutTarget(null);
		((target && triggerFor(target)) ?? listEl).focus();
		revoked = false;
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
		// tabIndex -1 so it can take focus when the control that opened the
		// sign-out dialog - a row, or the bulk button - is gone, or about
		// to be, by the time the dialog closes.
		<div class="space-y-2" ref={listEl} tabIndex={-1}>
			<div class="flex items-center justify-between gap-3">
				<h3 class="text-sm font-medium text-text-secondary">Your devices</h3>
				{/* Offered whenever there is anything to revoke, including a
				    single other session: the point is one confirmation instead
				    of one per row, and that holds at any count above zero.
				    Loading and error states are already empty sets - see
				    otherDevices - so this one condition covers them too. */}
				<Show when={otherDevices().length > 0}>
					<button
						type="button"
						ref={signOutAllEl}
						onClick={() =>
							setSignOutTarget({
								kind: "others",
								// Snapshot, so the set revoked is the set the
								// confirmation counted - not whatever the list happens
								// to hold once the user has answered the password
								// prompt.
								deviceIds: otherDevices().map((d) => d.deviceId),
							})
						}
						class="shrink-0 rounded bg-surface-3 px-2 py-1 text-xs text-danger-text-bright transition-colors hover:bg-danger hover:text-danger-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
					>
						Sign out all other sessions
					</button>
				</Show>
			</div>
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
									onSignOut={() =>
										setSignOutTarget({
											kind: "device",
											deviceId: device.deviceId,
											deviceName: deviceLabel(device),
										})
									}
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

			{/* Keyed so a different target always gets a fresh dialog: the
			    dialog builds its UIA flow (and its target-pinned deeplink) at
			    mount, and an unkeyed Show would swap the props underneath a
			    flow still bound to the previous target. */}
			<Show when={signOutTarget()} keyed>
				{(target) => (
					<SignOutSessionsDialog
						target={target}
						viaPortal={viaPortal}
						portalUrl={portalUrlFor(target)}
						onClose={closeSignOut}
						onSignedOut={() => {
							revoked = true;
							void refetch();
						}}
					/>
				)}
			</Show>
		</div>
	);
};

export { DeviceList };
