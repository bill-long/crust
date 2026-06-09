import { type Component, Show } from "solid-js";
import { useConfig } from "../../../../app/ConfigProvider";
import { useClient } from "../../../../client/client";
import { activeCallRoomId } from "../../../../stores/activeCall";
import { CallOverlayBroadcaster } from "./CallOverlayBroadcaster";
import { CallOverlayController } from "./CallOverlayController";
import { CallSessionController } from "./CallSessionController";

/**
 * Mounts the call-session lifecycle owner (`CallSessionController`)
 * ABOVE the per-route `Layout` so it survives navigation between
 * route shapes.
 *
 * Why this needs to live above `Layout`: SolidJS Router treats each
 * `<Route path="..." component={HomePage}/>` as a distinct route key
 * even when several routes share the same component. Navigating
 * between shapes (e.g. `/space/X/Y` -> `/home/Y`, which happens
 * whenever the call-status panel's "Return" action falls back from a
 * `/space/...` route to `/home/...`) therefore disposes the old
 * `HomePage` subtree and creates a new one. Before this hoist the
 * controller lived inside `Layout`, so that disposal ran
 * `useRtcSession`'s onCleanup which synchronously fires
 * `leaveRoomSession(...)` -- silently kicking the user out of the
 * call they just clicked "Return" on. Mounting here, as a sibling of
 * `<SyncGate>`'s children, keeps the controller's lifecycle anchored
 * to the parent route (which never remounts on sub-route navigation)
 * so the call survives.
 *
 * The view layer for the active call is split:
 *
 *   - `FullCallOverlay` covers the main pane while the user is on
 *     the call's room — rendered by `Layout`.
 *   - `CallStatusPanel` is docked above `UserBar` in the sidebar
 *     column whenever a call is active — also rendered by `Layout`.
 *     Both are pure views over `currentCallSession()` and own no
 *     lifecycle state, so they can safely live inside the remounting
 *     `Layout` subtree without risking the bug described above.
 *
 * Renders nothing visible itself. The keyed `<Show>` on
 * `activeCallRoomId()` forces a full unmount -> cleanup -> remount
 * cycle on room-id switch, preserving the invariant Phase 7B
 * established when the controller was inside `Layout`.
 *
 * Mounted intentionally OUTSIDE the sync-state `<Switch>` in
 * `SyncGate`: a transient sync error must not unmount the controller
 * and silently leave the call. `SyncGate` clears `activeCallRoomId`
 * on the `logged-out` transition so the controller renders nothing in
 * that terminal state.
 */
export const PersistentCallSurface: Component = () => {
	const { summaries } = useClient();
	const config = useConfig();

	return (
		<>
			{/* Producer for the separate desktop overlay window. Mounted
			    unconditionally (outside the keyed <Show>) so it survives the
			    call-end transition: during an active call it answers overlay
			    handshakes and republishes on changes, and it emits one final
			    inactive snapshot when the call ends. While idle it stays silent,
			    so an idle tab can't clobber a calling tab's snapshot. Renders
			    nothing. */}
			<CallOverlayBroadcaster />
			<Show when={activeCallRoomId()} keyed>
				{(rid) => (
					<>
						<CallSessionController
							roomId={rid}
							roomName={() => summaries[rid]?.name?.trim() || "this room"}
							elementCallUrl={config.elementCall.url}
						/>
						{/* Owns the floating voice-overlay (Document PiP) window
						    lifecycle. Mounted here so it shares the call's lifetime:
						    when the call ends the keyed <Show> unmounts this and the
						    controller's onCleanup closes any open overlay window. */}
						<CallOverlayController />
					</>
				)}
			</Show>
		</>
	);
};
