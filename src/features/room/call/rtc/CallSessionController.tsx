import { type MatrixEvent, RoomStateEvent } from "matrix-js-sdk";
import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	Show,
} from "solid-js";
import { useClient } from "../../../../client/client";
import { reportError } from "../../../../lib/reportError";
import { setActiveCallRoomId } from "../../../../stores/activeCall";
import { pushNotice } from "../../../../stores/notices";
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

/**
 * How long the media session may stay down, after having been connected,
 * before the call is ended outright (#434).
 *
 * "Down" is `livekit.status()` at "idle" or "error", which `useLivekitRoom`
 * reaches from several places — livekit-client giving up after exhausting its
 * own reconnect policy, a failed connect attempt (including a `LivekitJwtError`
 * token fetch), and its own teardown branches when `enabled` goes false or the
 * focus changes. Only the first is a genuine media death, so it is the GUARDS
 * below (`everMediaConnected`, `rtc.status() === "joined"`, `leaving()`,
 * `leaveRequested()`) rather than the status alone that decide whether the
 * countdown may run; this constant only decides how long to wait once they all
 * agree.
 *
 * What the wait is for: livekit-client is finished retrying by this point, so
 * the only thing that can still recover the call is Crust's own re-entry into
 * `doConnect` — which is incidental rather than designed, since it re-runs only
 * when the `activeFocus` memo yields a different value and its value-based
 * `equals` suppresses ticks for the same SFU. In practice that happens only
 * when unrelated membership churn perturbs the focus, so waiting longer mostly
 * buys a longer-lying UI rather than a better chance of recovery.
 *
 * 20s is comfortably past the point where any such re-entry would already have
 * moved the status to "connecting" (which cancels the countdown), and ending
 * the call is cheap to undo — Join is one click — whereas a call that silently
 * stopped carrying audio is not discoverable at all.
 */
const MEDIA_DOWN_GRACE_MS = 20_000;

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

	// Whether this call's Matrix room is encrypted, gating per-participant
	// media E2EE. The VALUE is sourced authoritatively from the room's
	// `m.room.encryption` state via `client.getRoom(...).hasEncryptionStateEvent()`
	// — the same `client.getRoom` source the join gate uses (`useRtcSession`
	// `joinBlockReason`) — NOT the `summaries` store's `isEncrypted`, which is
	// optimistically hard-coded `false` for freshly created/joined rooms until
	// the real state syncs (summaries.ts) and would let an encrypted room
	// transiently publish plaintext. It is wrapped in a signal and refreshed
	// on `RoomStateEvent.Events` so the `enabled` memo / bridge effects below
	// re-evaluate if encryption is enabled after mount. Encryption is
	// permanent once set, so we only ever flip to `true`.
	//
	// MatrixRTC per-participant media E2EE is only used when the room itself
	// is encrypted. In an UNENCRYPTED room the other clients (Element Call /
	// Cinny) send plaintext media — Element Call ties `encryptMedia` to the
	// room's encryption system (EC CallViewModel `getE2eeKeyProvider`). If
	// Crust unconditionally encrypted its outbound media here, it would be the
	// only encrypted stream in a plaintext call: peers can't decrypt it and
	// hear garbled noise, while we still decode their plaintext fine.
	//
	// Unknown room: a room missing from the store seeds `false` AND
	// independently blocks the join (the same `getRoom` null check in
	// `joinBlockReason`), so no media is published in that case. For a
	// non-null room, `hasEncryptionStateEvent()` is the authoritative,
	// ecosystem-standard encryption check — the same call Element uses to
	// decide whether to encrypt outgoing messages — and is reliable for a
	// joined, synced room, which is the only state a call is reachable
	// from. The remaining edge (encryption enabled AFTER mount) is handled
	// by the `RoomStateEvent.Events` listener below, which flips the signal
	// and forces the `enabled` memo to re-gate (a brief reconnect). We do
	// NOT default the unknown case to "encrypted": that would build a
	// bridge `ensureBridge` then keeps via its `e2ee() !== null`
	// short-circuit, re-encrypting alone if the room is actually
	// unencrypted — reintroducing the garbled-audio bug this fixes.
	const [roomEncrypted, setRoomEncrypted] = createSignal(
		client.getRoom(props.roomId)?.hasEncryptionStateEvent() ?? false,
	);
	const onRoomStateEvent = (event: MatrixEvent): void => {
		if (event.getType() !== "m.room.encryption") return;
		if (event.getRoomId() !== props.roomId) return;
		if (client.getRoom(props.roomId)?.hasEncryptionStateEvent() === true) {
			setRoomEncrypted(true);
		}
	};
	client.on(RoomStateEvent.Events, onRoomStateEvent);
	onCleanup(() => client.off(RoomStateEvent.Events, onRoomStateEvent));

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
				// Hold the LiveKit connect until the E2EE bridge exists,
				// but ONLY for encrypted rooms. Otherwise a
				// "joined-on-mount" mount (controller re-opens after a
				// non-Leave dismiss, hot reload, or route flip while
				// MatrixRTC still reports `isJoined()` true) would race
				// ahead and `r.connect()` WITHOUT `setE2EEEnabled(true)` —
				// publishing media in the clear. For an unencrypted room we
				// never build a bridge (plaintext media is correct), so
				// requiring e2ee() would deadlock the connect.
				(!roomEncrypted() || e2ee() !== null),
		),
		memberships: rtc.memberships,
		audioDeviceId: createMemo(() => userSettings().rtcMicDeviceId),
		videoDeviceId: createMemo(() => userSettings().rtcCamDeviceId),
		screenShareQuality: createMemo(() => userSettings().rtcScreenShareQuality),
		micEnabled: voiceMicEnabled,
		e2ee,
	});

	// Ensures media E2EE is set up before join when the room requires it.
	// Used by both the Join click handler AND the joined-on-mount recovery
	// effect below. Returns `true` when it is safe to proceed with the join:
	// either the room is unencrypted (no bridge needed — plaintext media,
	// matching peers) or a bridge is now installed (existed already or was
	// built successfully). Returns `false` only if the build threw or the
	// controller unmounted mid-build. On the unmount path the freshly-built
	// ctx is disposed inline — DO NOT setE2ee() because the signal would
	// outlive the owner with nothing else to dispose it.
	const ensureBridge = async (): Promise<boolean> => {
		// Unencrypted room: no media E2EE (plaintext, matching peers).
		// Returning true (without building a bridge) lets the join
		// proceed with `e2ee()` null → manageMediaKeys false.
		if (!roomEncrypted()) return true;
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
		// Unencrypted rooms never use a bridge (plaintext media).
		if (!roomEncrypted()) return;
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

	// Awaitable single-flight: every concurrent caller awaits the same
	// in-flight leave promise. Without this, a second `confirmLeave()`
	// call while one is already in flight (e.g. the ConfirmDialog
	// confirm fires while `switchCall` is also awaiting `requestLeave`)
	// would resolve immediately and let the caller misinterpret the
	// premature return as "leave succeeded". The eventual real
	// completion of the original leave would then run
	// `setActiveCallRoomId(null)` and clobber any room id the caller
	// had set in the meantime (PR B-2c regression scenario: switch A→B
	// while A is already mid-leave would land at `null`, not B).
	let leavePromise: Promise<void> | null = null;

	const runLeave = async (): Promise<void> => {
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
			//
			// Guarded on `unmounted` because a caller can stop awaiting this
			// leave and tear us down anyway — `endCallForRoomLeave` does
			// exactly that when the teardown outruns its timeout. By the time
			// a stale `runLeave` resumes, the signal may already point at a
			// NEWER call the user has since started, and clearing it here
			// would silently drop them from it.
			if (unmounted) return;
			setActiveCallRoomId(null);
		} finally {
			setLeaving(false);
		}
	};

	const confirmLeave = (): Promise<void> => {
		if (leavePromise) return leavePromise;
		leavePromise = runLeave().finally(() => {
			leavePromise = null;
		});
		return leavePromise;
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
		// Ensure media E2EE is set up BEFORE rtc.join() when the room
		// requires it, so the bridge listener is wired before
		// joinRoomSession (Phase-4 invariant 2) and the LiveKit Room sees
		// the e2ee accessor as non-null on its very first reactive read.
		// In an unencrypted room ensureBridge() is a no-op and returns
		// true (plaintext media, matching peers).
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

	// Media-death watchdog (#434). The watcher above only reads
	// `rtc.status()`, but the two layers fail independently: when
	// livekit-client gives up (SFU unreachable, duplicate identity, kicked)
	// it tears the media session down while MatrixRTC still reports
	// "joined". Nothing then ends the call, so the overlay keeps offering
	// Mute/Share controls over dead audio and our `m.call.member` stays
	// live — every other participant keeps seeing a tile that will never
	// speak.
	//
	// Ending it runs the real leave rather than just dropping the signal,
	// so the membership is withdrawn (awaited) instead of being left to the
	// unmount's fire-and-forget path.
	let everMediaConnected = false;
	let mediaDownTimer: ReturnType<typeof setTimeout> | undefined;
	const clearMediaDownTimer = (): void => {
		if (mediaDownTimer !== undefined) {
			clearTimeout(mediaDownTimer);
			mediaDownTimer = undefined;
		}
	};
	onCleanup(clearMediaDownTimer);

	createEffect(() => {
		const lk = livekit.status();
		if (lk === "connected") {
			// Latch: before the first successful connect, "idle" is just the
			// pre-connect state of a normal join, not a death.
			everMediaConnected = true;
			clearMediaDownTimer();
			return;
		}
		// "connecting"/"disconnecting" are in flight — give them their chance.
		const down = lk === "idle" || lk === "error";
		if (
			!down ||
			!everMediaConnected ||
			rtc.status() !== "joined" ||
			// Our own teardown already owns the lifecycle. `leaveRequested()`
			// is the right guard rather than `leaving()`: `runLeave` sets both
			// synchronously, but only this one OUTLIVES a leave that failed —
			// and that aftermath is the dangerous state. There the user sits in
			// the confirm dialog with Retry/Stay while `enabled` is
			// deliberately false, so LiveKit is parked at "idle" and can never
			// reach "connecting" to cancel us. Guarding on `leaving()` alone
			// would let the watchdog read Crust's own intentional media
			// suppression as a death, fire a second leave 20s later, and on its
			// likely failure unmount the controller — destroying the dialog the
			// user was reading and stranding the very membership this watchdog
			// exists to withdraw. "Stay" clears it, which re-arms us if the
			// media is still gone.
			leaveRequested()
		) {
			clearMediaDownTimer();
			return;
		}
		if (mediaDownTimer !== undefined) return; // already counting down
		mediaDownTimer = setTimeout(() => {
			mediaDownTimer = undefined;
			if (unmounted) return;
			// Say so: unlike the RTC-driven watcher above (where the session
			// ended server-side and the user's own client agrees), here the
			// call disappears while the app still believed it was live, so a
			// silent vanish reads as a bug.
			pushNotice("Call ended — lost connection to the voice server.");
			void confirmLeave().catch((err: unknown) => {
				// No `userMessage`: the notice above already told the user the
				// call ended, and #318's rule is not to double-signal.
				reportError(err, { logLabel: "Failed to end call after media loss" });
				// The media is gone either way; a call the user cannot hear
				// must not keep presenting itself as live.
				if (unmounted) return;
				setActiveCallRoomId(null);
			});
		}, MEDIA_DOWN_GRACE_MS);
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
