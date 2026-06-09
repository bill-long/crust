import { type Component, onCleanup, onMount } from "solid-js";
import { isNativeShell } from "../../../../app/nativeShell";
import { CallOverlayView } from "./CallOverlayView";
import { createCallOverlayConsumer } from "./callOverlayBridge";

/**
 * The `/overlay` route: the entire contents of the separate, always-on-top
 * desktop overlay window. It boots no MatrixClient of its own — it consumes the
 * call snapshot the main window publishes over the `crust:call-overlay`
 * BroadcastChannel and renders it, sending a "leave" command back when the user
 * hangs up.
 *
 * Rendered top-level (outside the auth/sync gates) so it works without a session
 * in this window. In the native shell the document background is made
 * transparent so the chromeless window lets the game behind it show through; in
 * a plain browser tab it stays on the app background as a preview.
 */
export const OverlayRoute: Component = () => {
	const consumer = createCallOverlayConsumer();
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
			onHangUp={consumer.sendLeave}
			translucent={isNativeShell()}
		/>
	);
};
