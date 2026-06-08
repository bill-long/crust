import { type Component, createEffect, onCleanup } from "solid-js";
import { micEnabled as voiceMicEnabled } from "../../../../stores/voice";
import {
	type CallOverlaySnapshot,
	createCallOverlayProducer,
	INACTIVE_SNAPSHOT,
} from "./callOverlayBridge";
import { currentCallSession } from "./callSessionStore";
import { closeNativeOverlay } from "./nativeOverlay";

/**
 * Producer half of the two-window call overlay. Lives in the main app window
 * (mounted by `PersistentCallSurface`, so it runs whenever the user is logged
 * in) and continuously broadcasts a snapshot of the active call over the
 * `crust:call-overlay` BroadcastChannel for the separate overlay window to
 * mirror. Renders nothing.
 *
 * The local participant's mute state folds in the voice store override (matching
 * `CallOverlayPanel` / `FullCallOverlay` / `UserBar`) so the overlay window —
 * which has neither a client nor the voice store — can render mute correctly
 * from the snapshot alone.
 */
export const CallOverlayBroadcaster: Component = () => {
	const buildSnapshot = (): CallOverlaySnapshot => {
		const session = currentCallSession();
		if (!session) return INACTIVE_SNAPSHOT;
		// Read the mic state once, up front, so the broadcasting effect always
		// tracks it — even if the local participant isn't currently in the
		// LiveKit list. Reading it only inside the (conditional) local-row branch
		// below would drop the dependency in that window, so a mute toggle
		// wouldn't republish and the overlay would show a stale mute state.
		const micOn = voiceMicEnabled();
		const participants = session.livekit.participants().map((p) => ({
			identity: p.identity,
			displayName: p.displayName,
			avatarUrl: p.avatarUrl,
			isLocal: p.isLocal,
			// Local mic: voice store is the responsive source of truth.
			isMuted: p.isLocal ? !micOn : p.isMuted,
			isSpeaking: p.isSpeaking,
		}));
		return {
			active: true,
			roomName: session.roomName(),
			participants,
		};
	};

	const producer = createCallOverlayProducer({
		getSnapshot: buildSnapshot,
		onLeave: () => {
			void currentCallSession()
				?.requestLeave()
				.catch(() => {
					// The session controller surfaces leave errors in its own
					// dialog; nothing actionable from the broadcaster.
				});
		},
	});

	// Republish whenever the call's participants, name, mic state, or the
	// session itself change (buildSnapshot reads all of them reactively).
	// An idle main-app tab (no active call) stays silent so it can't clobber a
	// calling tab's snapshot — it only emits the single inactive snapshot that
	// marks the transition out of a call it previously owned. The consumer binds
	// to one producer by id, so even with two tabs each in a call, one tab's
	// inactive emit cannot blank an overlay bound to the other.
	//
	// Remaining gap (Phase 2): a producer whose tab is hard-closed mid-call
	// sends no inactive emit, so a bound overlay shows a stale call until a
	// heartbeat/lease is added.
	let wasActive = false;
	createEffect(() => {
		const snapshot = buildSnapshot();
		if (snapshot.active) {
			wasActive = true;
			producer.publish(snapshot);
		} else if (wasActive) {
			wasActive = false;
			producer.publish(snapshot);
			// The call ended: tear down the native overlay window too (no-op in
			// a browser). The PiP overlay is closed separately by its controller.
			void closeNativeOverlay();
		}
	});

	onCleanup(() => producer.dispose());

	return null;
};
