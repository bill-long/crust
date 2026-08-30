import { type Component, Match, Show, Switch } from "solid-js";
import { Tooltip } from "../../components/Tooltip";
import type { DeviceVerification } from "../../lib/deviceVerification";
import { displayNameOr } from "../../lib/displayName";
import { formatRelativeTime } from "../../lib/relativeTime";

/**
 * Marks the row's sign-out control with its device id, so the list can put
 * focus back on it when the dialog closes. A data attribute rather than
 * the accessible name: label copy is user-facing and changes, and focus
 * behaviour must not break when it does.
 */
export const SIGN_OUT_ATTR = "data-sign-out-device";

export interface DeviceInfo {
	deviceId: string;
	displayName: string;
	lastSeenTs: number | undefined;
	verification: DeviceVerification;
	isCurrentDevice: boolean;
}

/** Last-resort label for a device the server described with neither a
 *  usable name nor an id. */
const UNNAMED_DEVICE = "Unnamed session";

/**
 * What to call this device in UI - its display name, or its id when the
 * server gave none usable.
 *
 * `displayNameOr` (`lib/displayName.ts`) is Element's display-name policy for
 * the names matrix-js-sdk never sees, and a device's `display_name` off
 * `/devices` is one of them - no `RoomMember` is involved, so nothing has
 * normalized it. It strips the two direction overrides, falls back when
 * nothing renders, and otherwise keeps the name: a device called
 * `Laptop<RLO>A` would reorder the row it sits on, while one merely carrying
 * a zero-width space is left alone, because barring those breaks real names
 * and the id line below already says which device this is.
 *
 * The terminal fallback is not decoration: `DeviceList` already treats a
 * device the server reports without an id as possible, so without it the
 * label could be empty and the button would announce a bare "Sign out",
 * indistinguishable from every other row's.
 *
 * Defined here so the row and the sign-out confirmation cannot drift apart
 * on what they call the same device.
 */
export function deviceLabel(
	device: Pick<DeviceInfo, "displayName" | "deviceId">,
): string {
	return displayNameOr(device.displayName, device.deviceId || UNNAMED_DEVICE);
}

interface DeviceItemProps {
	device: DeviceInfo;
	onVerify?: (deviceId: string) => void;
	/**
	 * Revoke this session (#556). Never offered for the current device -
	 * signing THAT out is logging out, which the app already has - so the
	 * row hides the control rather than relying on the caller to omit it.
	 */
	onSignOut?: (deviceId: string) => void;
}

function formatLastSeen(ts: number | undefined): string {
	if (!ts) return "Unknown";
	const label = formatRelativeTime(ts, Date.now());
	// Sentence position: "Just now" rather than "just now".
	return label.charAt(0).toUpperCase() + label.slice(1);
}

const DeviceItem: Component<DeviceItemProps> = (props) => {
	const label = (): string => deviceLabel(props.device);

	const unverifiedExplanation = (): string =>
		props.device.isCurrentDevice
			? "This session hasn't been verified. Verify it from another signed-in session so its messages can be cryptographically trusted."
			: "This session hasn't been verified — its messages can't be cryptographically trusted. Verify it to confirm it belongs to you.";

	return (
		<div class="flex items-center justify-between rounded-lg bg-surface-2/50 px-4 py-3">
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<span class="truncate text-sm font-medium text-text-primary">
						{label()}
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

				{/* Independent of verification status: any other session can be
				    revoked, verified or not. The list renders one of these per
				    row, so the accessible name has to name the device - the
				    visible "Sign out" alone would be ambiguous to a screen
				    reader walking the list. */}
				{/* No id means no `DELETE /devices/{id}` to send - offering the
				    control would promise an action that cannot be addressed. */}
				<Show
					when={
						!props.device.isCurrentDevice &&
						props.device.deviceId &&
						props.onSignOut
					}
				>
					<button
						type="button"
						onClick={() => props.onSignOut?.(props.device.deviceId)}
						aria-label={`Sign out ${label()}`}
						{...{ [SIGN_OUT_ATTR]: props.device.deviceId }}
						class="rounded bg-surface-3 px-2 py-1 text-xs text-danger-text-bright transition-colors hover:bg-danger hover:text-danger-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover"
					>
						Sign out
					</button>
				</Show>
			</div>
		</div>
	);
};

export { DeviceItem };
