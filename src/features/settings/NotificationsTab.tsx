import type { Component } from "solid-js";
import { updateSetting, userSettings } from "../../stores/settings";
import { SectionHeading, ToggleRow } from "./SettingsControls";

const NotificationsTab: Component = () => {
	const notificationsSupported =
		typeof window !== "undefined" && "Notification" in window;

	const handleDesktopNotifToggle = (checked: boolean): void => {
		if (!notificationsSupported) {
			// Allow toggling off even when unsupported (clears persisted state)
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
								? "Show system notifications for new messages"
								: "Desktop notifications are not supported in this browser"
					}
					checked={userSettings().desktopNotifications}
					onChange={handleDesktopNotifToggle}
				/>
				<ToggleRow
					label="Notification sound"
					description="Play a sound when you receive a notification"
					checked={userSettings().notificationSound}
					onChange={(v) => updateSetting("notificationSound", v)}
				/>
			</section>

			{/* Categories */}
			<section>
				<SectionHeading>Notification Categories</SectionHeading>
				<ToggleRow
					label="Mentions"
					description="Notify when someone mentions you or replies to your message"
					checked={userSettings().notifyMentions}
					onChange={(v) => updateSetting("notifyMentions", v)}
				/>
				<ToggleRow
					label="Direct messages"
					description="Notify for new direct messages"
					checked={userSettings().notifyDirectMessages}
					onChange={(v) => updateSetting("notifyDirectMessages", v)}
				/>
				<ToggleRow
					label="All messages"
					description="Notify for every message in all rooms (can be noisy)"
					checked={userSettings().notifyAllMessages}
					onChange={(v) => updateSetting("notifyAllMessages", v)}
				/>
			</section>
		</div>
	);
};

export { NotificationsTab };
