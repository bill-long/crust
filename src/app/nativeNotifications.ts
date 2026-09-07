import { invokeTauri, tauriIpcAvailable } from "./tauri";

/** Explicit IPC avoids the plugin's incomplete window.Notification shim. */
export async function requestNativeNotificationPermission(): Promise<boolean> {
	if (!tauriIpcAvailable())
		throw new Error("Restart Crust to enable notifications.");
	return (
		(await invokeTauri("plugin:notification|request_permission")) === "granted"
	);
}

export async function sendNativeNotification(
	title: string,
	body: string,
): Promise<void> {
	if (!tauriIpcAvailable())
		throw new Error("Native notifications are unavailable.");
	await invokeTauri("plugin:notification|notify", { options: { title, body } });
}
