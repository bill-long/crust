import {
	ClientEvent,
	type MatrixEvent,
	PushRuleKind,
	RuleId,
} from "matrix-js-sdk";
import {
	type Component,
	createSignal,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { useConfig } from "../../app/ConfigProvider";
import { requestNativeNotificationPermission } from "../../app/nativeNotifications";
import { isNativeShell } from "../../app/nativeShell";
import { useClient } from "../../client/client";
import { userFacingErrorMessage } from "../../lib/errorMessage";
import { accounts } from "../../stores/session";
import { updateSetting, userSettings } from "../../stores/settings";
import { isPushConfigured } from "../../types/config";
import { disableBackgroundNotifications } from "../notifications/accountPush";
import { enableWebPush, isPushSupported } from "../notifications/webPush";
import { SectionHeading, ToggleRow } from "./SettingsControls";

const NotificationsTab: Component = () => {
	const { client } = useClient();
	const config = useConfig();

	const notificationsSupported =
		isNativeShell() ||
		(typeof window !== "undefined" && "Notification" in window);
	const [notificationBusy, setNotificationBusy] = createSignal(false);
	const [notificationError, setNotificationError] = createSignal<string | null>(
		null,
	);
	let disposed = false;
	let permissionTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => {
		disposed = true;
		clearTimeout(permissionTimer);
	});

	const handleDesktopNotifToggle = (checked: boolean): void => {
		if (notificationBusy()) return;
		setNotificationError(null);
		if (!checked) {
			updateSetting("desktopNotifications", false);
			return;
		}
		if (!notificationsSupported) return;
		setNotificationBusy(true);
		void (async () => {
			try {
				const request = isNativeShell()
					? requestNativeNotificationPermission()
					: Notification.permission === "granted"
						? Promise.resolve(true)
						: Notification.requestPermission().then(
								(result) => result === "granted",
							);
				const granted = await Promise.race([
					request,
					new Promise<never>((_, reject) => {
						permissionTimer = setTimeout(
							() =>
								reject(
									new Error(
										"Notification permission did not respond. Try again.",
									),
								),
							30_000,
						);
					}),
				]);
				if (disposed) return;
				if (!granted)
					throw new Error(
						isNativeShell()
							? "Notifications are blocked. Check your system notification settings."
							: "Notification permission was not granted. Check your browser settings.",
					);
				updateSetting("desktopNotifications", true);
			} catch (error) {
				if (!disposed)
					setNotificationError(
						userFacingErrorMessage(
							error,
							"Couldn't enable notifications. Try again.",
						),
					);
			} finally {
				clearTimeout(permissionTimer);
				if (!disposed) setNotificationBusy(false);
			}
		})();
	};

	const permissionDenied =
		!isNativeShell() &&
		notificationsSupported &&
		Notification.permission === "denied";

	// Background Web Push (notifications while the app is closed).
	const pushSupported = isPushSupported();
	const pushAvailable = pushSupported && isPushConfigured(config.push);
	const [pushBusy, setPushBusy] = createSignal(false);
	const [pushError, setPushError] = createSignal<string | null>(null);

	const handleBackgroundPushToggle = (checked: boolean): void => {
		if (pushBusy()) return;
		setPushError(null);
		if (!checked) {
			setPushBusy(true);
			// Records the preference first and only then hands the registration
			// back - the shared order, and the reason for it, live in
			// `disableBackgroundNotifications`. Bounded, so a homeserver that never
			// answers cannot leave this toggle disabled for the rest of the session.
			disableBackgroundNotifications(client, config.push).finally(() =>
				setPushBusy(false),
			);
			return;
		}
		setPushBusy(true);
		enableWebPush(client, config.push)
			.then(() => {
				updateSetting("backgroundNotifications", true);
			})
			.catch((err: unknown) => {
				updateSetting("backgroundNotifications", false);
				setPushError(
					err instanceof Error
						? err.message
						: "Failed to enable background notifications",
				);
			})
			.finally(() => setPushBusy(false));
	};

	const backgroundPushDescription = (): string => {
		if (isNativeShell()) {
			return "Background notifications are unavailable in the desktop app. Use the web app to receive notifications while Crust is closed.";
		}
		if (!pushSupported) {
			return "Background notifications are not supported in this browser";
		}
		if (!isPushConfigured(config.push)) {
			return "Background notifications are not configured by this server";
		}
		// Background notifications follow the active account (#534): only one
		// account can be pushed to a device at a time, and switching moves them.
		// Say so where the toggle is, but only once there is a second account to
		// make the distinction meaningful. Reads the same reactive mirror the
		// switcher's own list does, so it tracks adding and removing accounts.
		if (accounts().length > 1) {
			return "Receive notifications even when Crust is closed, for the account you are signed in as";
		}
		return "Receive notifications even when Crust is closed";
	};

	// @room mention suppression — reads from push rules, reactive to updates
	const [suppressAtRoom, setSuppressAtRoom] = createSignal(false);
	const [atRoomLoaded, setAtRoomLoaded] = createSignal(false);
	const [savingAtRoom, setSavingAtRoom] = createSignal(false);

	function syncAtRoomState(): void {
		const rules = client.pushRules;
		if (!rules) return;
		const overrides = rules.global?.override;
		if (overrides) {
			const roomMentionRule = overrides.find(
				(r) => r.rule_id === RuleId.IsRoomMention,
			);
			const atRoomRule = overrides.find(
				(r) => r.rule_id === RuleId.AtRoomNotification,
			);
			setSuppressAtRoom(
				roomMentionRule?.enabled === false || atRoomRule?.enabled === false,
			);
		} else {
			setSuppressAtRoom(false);
		}
		setAtRoomLoaded(true);
	}

	onMount(syncAtRoomState);

	const onAccountData = (event: MatrixEvent): void => {
		if (event.getType() === "m.push_rules") {
			syncAtRoomState();
		}
	};
	client.on(ClientEvent.AccountData, onAccountData);
	onCleanup(() => {
		client.off(ClientEvent.AccountData, onAccountData);
	});

	const handleAtRoomToggle = (suppress: boolean): void => {
		if (savingAtRoom()) return;
		setSuppressAtRoom(suppress);
		setSavingAtRoom(true);

		// Disable both @room rules when suppressing
		const enabled = !suppress;
		Promise.allSettled([
			client.setPushRuleEnabled(
				"global",
				PushRuleKind.Override,
				RuleId.IsRoomMention,
				enabled,
			),
			client.setPushRuleEnabled(
				"global",
				PushRuleKind.Override,
				RuleId.AtRoomNotification,
				enabled,
			),
		])
			.then((results) => {
				if (results.some((r) => r.status === "rejected")) {
					// Re-read server state on partial or full failure
					syncAtRoomState();
				}
			})
			.finally(() => {
				setSavingAtRoom(false);
			});
	};

	return (
		<div class="space-y-8">
			{/* Desktop */}
			<section>
				<SectionHeading>Desktop Notifications</SectionHeading>
				<ToggleRow
					label="Enable desktop notifications"
					description={
						permissionDenied
							? "Permission denied - enable notifications in your browser settings"
							: notificationsSupported
								? "Show system notifications when the app is in the background"
								: "Desktop notifications are not supported in this browser"
					}
					checked={userSettings().desktopNotifications}
					onChange={handleDesktopNotifToggle}
					disabled={
						notificationBusy() ||
						(!notificationsSupported && !userSettings().desktopNotifications)
					}
				/>
				<Show when={notificationError()}>
					<p class="mt-1 text-xs text-danger-text" role="alert">
						{notificationError()}
					</p>
				</Show>
			</section>

			{/* Background (Web Push) */}
			<section>
				<SectionHeading>Background Notifications</SectionHeading>
				<ToggleRow
					label="Enable background notifications"
					description={backgroundPushDescription()}
					checked={!isNativeShell() && userSettings().backgroundNotifications}
					onChange={handleBackgroundPushToggle}
					disabled={
						isNativeShell() ||
						pushBusy() ||
						(!pushAvailable && !userSettings().backgroundNotifications)
					}
				/>
				<Show when={pushError()}>
					<p class="mt-1 text-xs text-danger-text" role="alert">
						{pushError()}
					</p>
				</Show>
			</section>

			{/* Sounds */}
			<section>
				<SectionHeading>Sounds</SectionHeading>
				<ToggleRow
					label="Notification sound"
					description="Play a sound for new messages in other rooms"
					checked={userSettings().notificationSound}
					onChange={(v) => updateSetting("notificationSound", v)}
				/>
				<ToggleRow
					label="Voice channel join/leave sound"
					description="Play a sound when someone joins or leaves a voice channel you're in"
					checked={userSettings().voiceJoinLeaveSound}
					onChange={(v) => updateSetting("voiceJoinLeaveSound", v)}
				/>
			</section>

			{/* @room suppression */}
			<section>
				<SectionHeading>Mentions</SectionHeading>
				<ToggleRow
					label="Suppress @room mentions"
					description="Prevent @room mentions from triggering notifications"
					checked={suppressAtRoom()}
					onChange={handleAtRoomToggle}
					disabled={!atRoomLoaded() || savingAtRoom()}
				/>
			</section>
		</div>
	);
};

export { NotificationsTab };
