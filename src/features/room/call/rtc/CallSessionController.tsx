import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	Show,
} from "solid-js";
import { useClient } from "../../../../client/client";
import { setActiveCallRoomId } from "../../../../stores/activeCall";
import { userSettings } from "../../../../stores/settings";
import { micEnabled as voiceMicEnabled } from "../../../../stores/voice";
import { ConfirmDialog } from "../../settings/ConfirmDialog";
import {
	allocCallSessionInstanceId,
	type CallSessionApi,
	clearCallSessionIfCurrent,
	publishCallSession,
} from "./callSessionStore";
import { createRtcE2EEContext, type RtcE2EEContext } from "./rtcE2EEBridge";
import { useLivekitRoom } from "./useLivekitRoom";
import { useRtcSession } from "./useRtcSession";

interface CallSessionControllerProps {
	/**
	 * Stable room id for this controller instance. The parent must mount
	 * the controller via a `<Show ... keyed>` so changing room ids force
	 * a full unmount → cleanup → remount cycle. Mutating this prop on a
	 * live instance is not supported (the underlying RTC + LiveKit hooks
	 * snapshot the id at construction).
	 */
	roomId: string;
	/** Accessor for the active call's display name; resolved from summaries. */
	roomName: () => string;
	/** Operator-deployed Element Call URL — used by foci discovery. */
	elementCallUrl: string;
}

/**
 * Owns the MatrixRTC + LiveKit session lifecycle for a single active
 * call. Renders no visible chrome — only the leave-confirmation
 * `ConfirmDialog`, which is owned here so it survives the user
 * navigating away from the call's room (the visible chrome may unmount
 * during navigation; the dialog must not).
 *
 * Mounted at `Layout` level inside a `<Show when={activeCallRoomId()} keyed>`
 * so the call session persists across route changes (Phase 7B of
 * issue #122 — closes #99 bullets 2 & 4). When the user explicitly
 * leaves the call (or the SDK terminates it externally), the controller
 * clears `activeCallRoomId` which removes the `<Show>` and tears the
 * controller down via `onCleanup`.
 *
 * All the subtle teardown ordering / single-flight / sticky-suppressor /
 * joined-on-mount-recovery / E2EE-bridge-before-join invariants
 * previously documented inline in `NativeCallView` are preserved here
 * verbatim — see the comments in-place.
 */
export const CallSessionController: Component<CallSessionControllerProps> = (
	props,
) => {
	const { client } = useClient();

	// Phase 4 E2EE bridge — created lazily on the first Join click so
	// the LiveKit chunk + the e2ee worker stay deferred until the user
	// actually opts in to a call. One context per join cycle: leaving
	// disposes it and a re-join creates a fresh one. Reusing a context
	// across Leave→Re-Join would accumulate listeners on the keyProvider
	// inside LiveKit's E2EEManager (it doesn't unbind on disconnect).
	const [e2ee, setE2ee] = createSignal<RtcE2EEContext | null>(null);
	const [bridgeInitializing, setBridgeInitializing] = createSignal(false);
	const [bridgeInitError, setBridgeInitError] = createSignal<Error | null>(
		null,
	);

	// Register the bridge-disposal cleanup BEFORE the hooks below. SolidJS
	// runs `onCleanup` callbacks in LIFO order (last registered runs
	// first), so registering this FIRST guarantees it runs LAST — after
	// `useLivekitRoom`'s teardown has called `binding.release()` on the
	// active Room and after `useRtcSession` has detached the bridge
	// listener.
	//
	// `unmounted` is checked by every async path after each await so a
	// fast unmount during `createRtcE2EEContext()` (dynamic LiveKit chunk
	// + worker module load takes tens of ms) can't strand a fresh bridge.
	let unmounted = false;
	onCleanup(() => {
		unmounted = true;
		const ctx = e2ee();
		if (ctx) {
			// Defer worker termination until useLivekitRoom's in-flight
			// disconnect has released its binding. SolidJS's `onCleanup`
			// chain is synchronous and does NOT await returned promises,
			// so the cross-hook LIFO claim alone cannot enforce
			// "worker.terminate() AFTER r.disconnect()" on the
			// unmount-while-joined path. Chain here instead.
			void livekit.teardownComplete().then(
				() => {
					ctx.dispose();
				},
				() => {
					ctx.dispose();
				},
			);
			setE2ee(null);
		}
	});

	const rtc = useRtcSession({
		client,
		roomId: props.roomId,
		elementCallUrl: props.elementCallUrl,
		e2ee,
	});

	// Synchronously gates `enabled` while a Leave is in flight so the
	// LiveKit effect can't re-enter the call between `livekit.disconnect()`
	// resolving and `rtc.leave()` flipping its own status. Without this,
	// a Matrix sync microtask landing in that window could update focus,
	// fire the LiveKit hook's focus-change branch (which sees `enabled`
	// still true because `rtc.status()` is still "joined"), and queue a
	// fresh `doConnect` after the user clicked Leave. Must be declared
	// before useLivekitRoom because the `enabled` memo reads it during
	// synchronous setup (createMemo runs its computation once eagerly).
	//
	// `leaving` is the single-flight guard for the leave path (cleared in
	// its finally so the user can retry after a failure).
	// `leaveRequested` is a sticky suppressor that stays true after a
	// failed leave so the LiveKit hook does NOT silently reconnect the
	// mic while the error dialog is still on screen. It is cleared only
	// on a successful leave (component unmount) or when the user
	// explicitly dismisses the confirmation dialog with "Stay".
	const [leaving, setLeaving] = createSignal(false);
	const [leaveRequested, setLeaveRequested] = createSignal(false);
	// Captures the error from a failed direct-button leave so it can be
	// surfaced inside the ConfirmDialog body (which has a backdrop that
	// obscures the underlying call view).
	const [leaveError, setLeaveError] = createSignal<Error | null>(null);

	const livekit = useLivekitRoom({
		client,
		focus: rtc.activeFocus,
		enabled: createMemo(
			() =>
				!leaving() &&
				!leaveRequested() &&
				rtc.status() === "joined" &&
				rtc.activeFocus() !== null &&
				// Hold the LiveKit connect until the E2EE bridge exists.
				// Otherwise a "joined-on-mount" mount (controller re-opens
				// after a non-Leave dismiss, hot reload, or route flip
				// while MatrixRTC still reports `isJoined()` true) would
				// race ahead and `r.connect()` WITHOUT
				// `setE2EEEnabled(true)` — publishing media in the clear.
				e2ee() !== null,
		),
		memberships: rtc.memberships,
		audioDeviceId: createMemo(() => userSettings().rtcMicDeviceId),
		videoDeviceId: createMemo(() => userSettings().rtcCamDeviceId),
		micEnabled: voiceMicEnabled,
		e2ee,
	});

	// Builds and installs the E2EE bridge if not already present.
	// Used by both the Join click handler AND the joined-on-mount
	// recovery effect below. Returns `true` if a bridge is now installed
	// (existed already or was built successfully), `false` if the build
	// threw or the controller unmounted mid-build. On the unmount path
	// the freshly-built ctx is disposed inline — DO NOT setE2ee() because
	// the signal would outlive the owner with nothing else to dispose it.
	const ensureBridge = async (): Promise<boolean> => {
		if (e2ee() !== null) return true;
		setBridgeInitError(null);
		setBridgeInitializing(true);
		try {
			const ctx = await createRtcE2EEContext();
			if (unmounted) {
				ctx.dispose();
				return false;
			}
			// Defensive: if a concurrent ensureBridge() call resolved first
			// and already installed a context, dispose the duplicate we
			// just built so its worker is terminated instead of leaked.
			if (e2ee() !== null) {
				ctx.dispose();
				return true;
			}
			setE2ee(ctx);
			return true;
		} catch (err) {
			if (!unmounted) {
				setBridgeInitError(err instanceof Error ? err : new Error(String(err)));
			}
			return false;
		} finally {
			if (!unmounted) setBridgeInitializing(false);
		}
	};

	// Joined-on-mount recovery: if the controller mounts while MatrixRTC
	// still reports `isJoined()` true (close-without-leave flow, hot
	// reload, programmatic close that bypasses requestClose), the Join
	// handler never runs and the bridge is never built. The `enabled`
	// memo above keeps useLivekitRoom dormant until e2ee() is non-null,
	// so this effect builds the bridge so the connection can proceed
	// encrypted.
	createEffect(() => {
		if (unmounted) return;
		if (rtc.status() !== "joined") return;
		if (e2ee() !== null) return;
		if (bridgeInitializing()) return;
		// Halt auto-retry after a failure: ensureBridge sets
		// bridgeInitError on failure and resets bridgeInitializing to
		// false, which would otherwise re-trigger this effect immediately.
		if (bridgeInitError() !== null) return;
		void ensureBridge();
	});

	const [confirmLeaveOpen, setConfirmLeaveOpen] = createSignal(false);

	// Tracks whether the controller has ever transitioned through
	// `joined` so the SDK-driven termination watcher below only fires
	// for unexpected ends — not for never-joined controllers that the
	// user simply dismissed before joining.
	let everJoined = false;

	const confirmLeave = async (): Promise<void> => {
		// Single-flight: a second click on "Leave" while the first call
		// is still awaiting must not re-enter.
		if (leaving()) return;
		setLeaveError(null);
		// Flip `leaving` BEFORE any await so the LiveKit effect's disable
		// branch fires synchronously (epoch-gated teardown) and the
		// focus-change branch is unreachable until we finish.
		setLeaving(true);
		setLeaveRequested(true);
		try {
			await livekit.disconnect();
			await rtc.leave();
			// rtc.leave() never rejects — it stores errors on rtc.error()
			// and reverts status to "joined" only when the SDK still
			// reports joined. Throw from here so ConfirmDialog keeps the
			// dialog open and shows the error instead of silently
			// unmounting the overlay while the call is live.
			if (rtc.status() === "joined") {
				throw new Error(rtc.error()?.message ?? "Leave failed.");
			}
			// Dispose the E2EE bridge AFTER LiveKit disconnect + Matrix
			// leave have completed (or the throw above has propagated).
			const ctx = e2ee();
			if (ctx) {
				ctx.dispose();
				setE2ee(null);
			}
			setConfirmLeaveOpen(false);
			// Clear the global active-call signal LAST so the controller
			// is torn down only after every awaited teardown has settled.
			// The `<Show ... keyed>` in Layout drops us synchronously on
			// the next tick, triggering our onCleanup.
			setActiveCallRoomId(null);
		} finally {
			setLeaving(false);
		}
	};

	const requestClose = (): void => {
		// While a leave is in flight, ignore close requests. If the leave
		// fails server-side and the SDK reports we're still joined, the
		// user needs the overlay (and its error surface) to retry.
		if (leaving() || rtc.status() === "leaving") return;
		if (rtc.status() === "joined" || rtc.status() === "joining") {
			setConfirmLeaveOpen(true);
			return;
		}
		// Not joined yet (still in idle/error) — discarding the active
		// call signal is safe and there is nothing to await.
		setActiveCallRoomId(null);
	};

	const requestJoin = async (): Promise<void> => {
		if (bridgeInitializing()) return;
		// Build the E2EE bridge BEFORE rtc.join() so the bridge listener
		// is wired before joinRoomSession (Phase-4 invariant 2) and the
		// LiveKit Room sees the e2ee accessor as non-null on its very
		// first reactive read.
		const ok = await ensureBridge();
		if (!ok) return;
		if (unmounted) return;
		await rtc.join();
	};

	const requestLeave = async (): Promise<void> => {
		try {
			await confirmLeave();
		} catch (err) {
			setLeaveError(err instanceof Error ? err : new Error(String(err)));
			// Failed direct leave: open the confirm dialog so the user
			// has explicit Retry (Leave call) and recovery (Stay)
			// actions. The dialog body surfaces `leaveError` inside the
			// modal so the user sees what went wrong without it being
			// obscured by the dialog backdrop.
			setConfirmLeaveOpen(true);
			throw err;
		}
	};

	// SDK-driven termination watcher: if the call ends via something
	// other than `confirmLeave()` (network drop, kick, server-side
	// session teardown), the controller would otherwise stay mounted
	// with no live session. Detect once-joined-then-no-longer-active
	// and clear the active-call signal so chrome unmounts cleanly.
	createEffect(() => {
		const s = rtc.status();
		if (s === "joined") {
			everJoined = true;
			return;
		}
		if (!everJoined) return;
		if (leaving()) return; // confirmLeave() handles its own cleanup
		if (s === "idle" || s === "error") {
			setActiveCallRoomId(null);
		}
	});

	const instanceId = allocCallSessionInstanceId();
	const api: CallSessionApi = {
		instanceId,
		roomId: props.roomId,
		roomName: props.roomName,
		rtc,
		livekit,
		bridgeInitializing,
		bridgeInitError,
		leaving,
		requestJoin,
		requestClose,
		requestLeave,
	};

	// Publish synchronously during init (not deferred to onMount) so
	// chrome rendered on the same tick as the controller (e.g. the
	// `FullCallOverlay` gated on `activeCallRoomId() === routeRoomId`)
	// sees a non-null session on its very first read. Doing this in
	// `onMount` would render the overlay with `null` once and flicker.
	publishCallSession(api);
	onCleanup(() => {
		clearCallSessionIfCurrent(instanceId);
	});

	return (
		<ConfirmDialog
			open={confirmLeaveOpen}
			onClose={() => {
				setConfirmLeaveOpen(false);
				// User dismissed the dialog (e.g. clicked "Stay" after a
				// failed leave). Clear the sticky suppressor so the
				// LiveKit hook can reconnect if they are still joined,
				// and clear any captured direct-button leave error.
				setLeaveRequested(false);
				setLeaveError(null);
			}}
			title="Leave call?"
			body={
				<>
					Closing this panel will end your participation in the call. You can
					rejoin from the room header at any time.
					<Show when={leaveError()}>
						{(err) => (
							<p
								class="mt-3 rounded bg-danger-bg/30 px-3 py-1.5 text-xs text-danger-text"
								role="alert"
							>
								Previous leave attempt failed: {err().message}
							</p>
						)}
					</Show>
				</>
			}
			confirmLabel="Leave call"
			cancelLabel="Stay"
			destructive
			onConfirm={confirmLeave}
		/>
	);
};
