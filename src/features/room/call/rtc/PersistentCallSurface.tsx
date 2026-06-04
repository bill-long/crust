import { type Component, Show } from "solid-js";
import { useConfig } from "../../../../app/ConfigProvider";
import { useClient } from "../../../../client/client";
import { activeCallRoomId } from "../../../../stores/activeCall";
import { CallSessionController } from "./CallSessionController";
import { MiniCallWidget } from "./MiniCallWidget";

/**
 * Mounts the call-session lifecycle owner (`CallSessionController`) and
 * the floating `MiniCallWidget` ABOVE the per-route `Layout` so they
 * survive navigation between route shapes.
 *
 * Why this needs to live above `Layout`: SolidJS Router treats each
 * `<Route path="..." component={HomePage}/>` as a distinct route key
 * even when several routes share the same component. Navigating between
 * shapes (e.g. `/space/X/Y` -> `/home/Y`, which happens whenever the
 * mini-widget's "Return" button falls back from a `/space/...` route to
 * `/home/...`) therefore disposes the old `HomePage` subtree and
 * creates a new one. Before this hoist the controller lived inside
 * `Layout`, so that disposal ran `useRtcSession`'s onCleanup which
 * synchronously fires `leaveRoomSession(...)` -- silently kicking the
 * user out of the call they just clicked "Return" on. Mounting here,
 * as a sibling of `<SyncGate>`'s children, keeps the controller's
 * lifecycle anchored to the parent route (which never remounts on
 * sub-route navigation) so the call survives.
 *
 * Renders nothing visible until `activeCallRoomId()` becomes non-null.
 * The keyed `<Show>` on `activeCallRoomId()` is preserved here so a
 * room-id switch still forces a full unmount -> cleanup -> remount
 * cycle (the same invariant Phase 7B established when the controller
 * was inside `Layout`).
 *
 * Mounted intentionally OUTSIDE the sync-state `<Switch>` in
 * `SyncGate`: a transient sync error must not unmount the controller
 * and silently leave the call. The widget/controller still render
 * during the brief "logged-out" message window before the redirect,
 * but `SyncGate` clears `activeCallRoomId` on the `logged-out`
 * transition so both gates render nothing in practice.
 */
export const PersistentCallSurface: Component = () => {
	const { summaries } = useClient();
	const config = useConfig();

	return (
		<>
			<Show when={activeCallRoomId()} keyed>
				{(rid) => (
					<CallSessionController
						roomId={rid}
						roomName={() => summaries[rid]?.name?.trim() || "this room"}
						elementCallUrl={config.elementCall.url}
					/>
				)}
			</Show>
			<MiniCallWidget summaries={summaries} />
		</>
	);
};
