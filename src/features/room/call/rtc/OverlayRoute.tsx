import { type Component, createSignal, onCleanup, onMount } from "solid-js";
import { isNativeShell } from "../../../../app/nativeShell";
import { invokeTauri, tauriIpcAvailable } from "../../../../app/tauri";
import { reportError } from "../../../../lib/reportError";
import { CallOverlayView } from "./CallOverlayView";
import { createCallOverlayConsumer } from "./callOverlayBridge";

/**
 * The `/overlay` route: the entire contents of the separate, always-on-top
 * desktop overlay window. It boots no MatrixClient of its own - it consumes the
 * call snapshot the main window publishes over the `crust:call-overlay`
 * BroadcastChannel and renders it. Hang-up uses native IPC so the shell can
 * verify the requesting window's identity.
 *
 * Rendered top-level (outside the auth/sync gates) so it works without a session
 * in this window. In the native shell the document background is made
 * transparent so the chromeless window lets the game behind it show through; in
 * a plain browser tab it stays on the app background as a preview.
 */
export const OverlayRoute: Component = () => {
	const consumer = createCallOverlayConsumer();
	const [hangUpError, setHangUpError] = createSignal<string | null>(null);
	onCleanup(() => consumer.dispose());

	onMount(() => {
		if (!isNativeShell()) return;
		const root = document.documentElement;
		const { body } = document;
		const prevRoot = root.style.background;
		const prevBody = body.style.background;
		root.style.background = "transparent";
		body.style.background = "transparent";
		onCleanup(() => {
			root.style.background = prevRoot;
			body.style.background = prevBody;
		});
	});

	return (
		<CallOverlayView
			snapshot={consumer.snapshot()}
			onHangUp={
				isNativeShell()
					? () => {
							setHangUpError(null);
							if (!tauriIpcAvailable()) {
								setHangUpError(
									"Couldn't disconnect. Use the main Crust window.",
								);
								return;
							}
							void invokeTauri("leave_overlay_call").catch((error) => {
								reportError(error, {
									logLabel: "Overlay hang-up",
								});
								setHangUpError(
									"Couldn't disconnect. Use the main Crust window.",
								);
							});
						}
					: undefined
			}
			translucent={isNativeShell()}
			hangUpError={hangUpError()}
		/>
	);
};
