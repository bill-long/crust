import {
	ClientEvent,
	type MatrixEvent,
	PushRuleKind,
	RuleId,
} from "matrix-js-sdk";
import { type Component, createSignal, onCleanup, onMount } from "solid-js";
import { useClient } from "../../client/client";
import { updateSetting, userSettings } from "../../stores/settings";
import { SectionHeading, ToggleRow } from "./SettingsControls";

const NotificationsTab: Component = () => {
	const { client } = useClient();

	const notificationsSupported =
		typeof window !== "undefined" && "Notification" in window;

	const handleDesktopNotifToggle = (checked: boolean): void => {
		if (!notificationsSupported) {
			if (!checked) updateSetting("desktopNotifications", false);
			return;
		}
		if (checked && Notification.permission === "denied") {
			updateSetting("desktopNotifications", false);
			return;
		}
		if (checked && Notification.permission === "default") {
			Notification.requestPermission()
				.then((result) => {
					updateSetting("desktopNotifications", result === "granted");
				})
				.catch(() => {
					updateSetting("desktopNotifications", false);
				});
		} else {
			updateSetting("desktopNotifications", checked);
		}
	};

	const permissionDenied =
		notificationsSupported && Notification.permission === "denied";

	// @room mention suppression — reads from push rules, reactive to updates
	const [suppressAtRoom, setSuppressAtRoom] = createSignal(false);
	const [atRoomLoaded, setAtRoomLoaded] = createSignal(false);

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
		const prev = suppressAtRoom();
		setSuppressAtRoom(suppress);

		// Disable both @room rules when suppressing
		const enabled = !suppress;
		Promise.all([
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
		]).catch(() => {
			setSuppressAtRoom(prev);
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
							? "Permission denied — enable notifications in your browser settings"
							: notificationsSupported
								? "Show system notifications when the app is in the background"
								: "Desktop notifications are not supported in this browser"
					}
					checked={userSettings().desktopNotifications}
					onChange={handleDesktopNotifToggle}
				/>
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
			</section>

			{/* @room suppression */}
			<section>
				<SectionHeading>Mentions</SectionHeading>
				<ToggleRow
					label="Suppress @room mentions"
					description="Prevent @room mentions from triggering notifications"
					checked={suppressAtRoom()}
					onChange={handleAtRoomToggle}
					disabled={!atRoomLoaded()}
				/>
			</section>
		</div>
	);
};

export { NotificationsTab };
