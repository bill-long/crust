import { endActiveCall } from "../features/room/call/rtc/endCall";
import { reportError } from "../lib/reportError";
import { isNativeShell, isOverlayWindow } from "./nativeShell";
import { invokeTauri, listenTauri, type UnlistenTauri } from "./tauri";

/** Keep the main renderer alive until its call withdrawal has settled. */
export async function watchNativeShutdown(): Promise<UnlistenTauri> {
	if (!isNativeShell() || isOverlayWindow()) return () => {};
	let preparing = false;
	return listenTauri("crust://prepare-shutdown", () => {
		if (preparing) return;
		preparing = true;
		void (async () => {
			try {
				await endActiveCall();
			} catch (error) {
				reportError(error, { logLabel: "Call teardown before desktop quit" });
			} finally {
				try {
					await invokeTauri("complete_shutdown");
				} catch (error) {
					reportError(error, { logLabel: "Completing desktop quit" });
				}
			}
		})();
	});
}
