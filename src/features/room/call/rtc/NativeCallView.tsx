import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { useClient } from "../../../../client/client";
import { cryptoDialogOpen } from "../../../../stores/cryptoActions";
import { userSettings } from "../../../../stores/settings";
import { ConfirmDialog } from "../../settings/ConfirmDialog";
import { createRtcE2EEContext, type RtcE2EEContext } from "./rtcE2EEBridge";
import {
	type LivekitRoomApi,
	type RtcParticipant,
	useLivekitRoom,
} from "./useLivekitRoom";
import { useRtcSession } from "./useRtcSession";

interface NativeCallViewProps {
	elementCallUrl: string;
	roomId: string;
	roomName: string;
	onClose: () => void;
}

const FOCUSABLE_SELECTOR =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Phase 1 placeholder UI for the native MatrixRTC client (issue #122).
 *
 * Renders only the controls needed to validate membership join/leave: a
 * Join/Leave button, a status line, and a live list of remote member
 * identities. Phase 2 will replace the placeholder body with the audio
 * tracks + media controls. The shell (header, close button, leave
 * confirmation, Escape handler) intentionally mirrors `CallOverlay` so the
 * two paths feel identical to a tester flipping `VITE_NATIVE_RTC`.
 */
export const NativeCallView: Component<NativeCallViewProps> = (props) => {
	const { client } = useClient();

	// Phase 4 E2EE bridge — created lazily on the first Join click so
	// the LiveKit chunk + the e2ee worker stay deferred until the user
	// actually opts in to a call. One context per join cycle: leaving
	// disposes it and a re-join creates a fresh one. Reusing a context
	// across Leave→Re-Join would accumulate listeners on the keyProvider
	// inside LiveKit's E2EEManager (it doesn't unbind on disconnect).
	const [e2ee, setE2ee] = createSignal<RtcE2EEContext | null>(null);
	// Bridge-init UI signals: prevents Join button double-click during
	// the `await createRtcE2EEContext()` window (where `rtc.status()`
	// is still "idle") and surfaces the error inside the existing
	// join-block banner.
	const [bridgeInitializing, setBridgeInitializing] = createSignal(false);
	const [bridgeInitError, setBridgeInitError] = createSignal<Error | null>(
		null,
	);

	// Register the bridge-disposal cleanup BEFORE the hooks below. SolidJS
	// runs `onCleanup` callbacks in LIFO order (last registered runs
	// first), so registering this FIRST guarantees it runs LAST — after
	// `useLivekitRoom`'s teardown has called `binding.release()` on the
	// active Room and after `useRtcSession` has detached the bridge
	// listener. Terminating the (last remaining) worker before
	// `room.disconnect()` resolves could surface errors in the LiveKit
	// E2EEManager's final teardown frames.
	//
	// `unmounted` is checked by the Join async handler AND the
	// joined-on-mount recovery effect after every await so a fast
	// unmount during `createRtcE2EEContext()` (dynamic LiveKit chunk +
	// worker module load takes tens of ms) can't strand a fresh bridge
	// in `e2ee()` and proceed to publish a phantom MatrixRTC membership
	// the user never sees a UI for. The async builders dispose the
	// freshly-built ctx themselves on the stale path.
	let unmounted = false;
	onCleanup(() => {
		unmounted = true;
		const ctx = e2ee();
		if (ctx) {
			// Defer worker termination until useLivekitRoom's in-flight
			// disconnect (kicked off by its own synchronous `onCleanup`
			// calling `void teardown()`) has released its binding.
			// SolidJS's `onCleanup` chain is synchronous and does NOT
			// await returned promises, so the cross-hook LIFO claim
			// alone cannot enforce "worker.terminate() AFTER
			// r.disconnect()" on this unmount-while-joined path. Chain
			// here instead. The `void` is intentional — Solid will not
			// wait on this either, but the consumer (the LiveKit close
			// handlers running before disconnect resolves) does the
			// last reads on the keyProvider, and once we're past those
			// the worker can safely terminate.
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
	// `leaving` is the single-flight guard for `confirmLeave` (cleared in
	// its finally so the user can retry after a failure). `leaveRequested`
	// is a sticky suppressor that stays true after a failed leave so the
	// LiveKit hook does NOT silently reconnect the mic while the error
	// dialog is still on screen. It is cleared only on a successful leave
	// (component unmount) or when the user explicitly dismisses the
	// confirmation dialog with "Stay".
	const [leaving, setLeaving] = createSignal(false);
	const [leaveRequested, setLeaveRequested] = createSignal(false);
	// Captures the error from a failed direct-button leave so it can be
	// surfaced inside the ConfirmDialog body (which has a backdrop that
	// obscures the underlying call view). Cleared on dialog dismiss and at
	// the start of every retry so it does not duplicate ConfirmDialog's
	// own internal handleConfirm error slot.
	const [leaveError, setLeaveError] = createSignal<Error | null>(null);

	const livekit = useLivekitRoom({
		client,
		focus: rtc.activeFocus,
		// Only connect once we're actually joined; teardown if leaving/error.
		enabled: createMemo(
			() =>
				!leaving() &&
				!leaveRequested() &&
				rtc.status() === "joined" &&
				rtc.activeFocus() !== null &&
				// Hold the LiveKit connect until the E2EE bridge exists.
				// Otherwise a "joined-on-mount" mount (parent re-opens the
				// overlay after a non-Leave close, hot reload, or route
				// flip while MatrixRTC still reports `isJoined()` true)
				// would race ahead and `r.connect()` WITHOUT
				// `setE2EEEnabled(true)` — publishing media in the clear.
				// The joined-on-mount recovery effect below builds the
				// bridge and flips this to true. Join-button mounts build
				// the bridge inside the click handler BEFORE flipping
				// rtc.status() to "joined", so this gate doesn't delay
				// the normal path.
				e2ee() !== null,
		),
		memberships: rtc.memberships,
		audioDeviceId: createMemo(() => userSettings().rtcMicDeviceId),
		videoDeviceId: createMemo(() => userSettings().rtcCamDeviceId),
		e2ee,
	});

	// Builds and installs the E2EE bridge if not already present.
	// Used by both the Join click handler AND the joined-on-mount
	// recovery effect below. Returns `true` if a bridge is now installed
	// (existed already or was built successfully), `false` if the build
	// threw or the view unmounted mid-build. On the unmount-mid-build
	// path the freshly-built ctx is disposed inline — DO NOT setE2ee()
	// because the signal would outlive the owner with nothing else to
	// dispose it. On failure, `bridgeInitError` is set so the
	// join-block banner surfaces a real reason instead of silently
	// downgrading to unencrypted.
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
			// and already installed a context, dispose the duplicate we just
			// built so its worker is terminated instead of leaked. The
			// pre-await guard at the top of this function (and the
			// `bridgeInitializing` gate in the recovery effect) make this
			// race difficult to trigger in practice, but a fresh context
			// holds a worker and listener bindings that we must not orphan.
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

	// Joined-on-mount recovery: if the parent re-opens the call overlay
	// while MatrixRTC still reports `isJoined()` true (close-without-leave
	// flow, hot reload, programmatic close that bypasses requestClose's
	// confirm dialog), the Join handler never runs and the bridge is
	// never built. The `enabled` memo above keeps useLivekitRoom dormant
	// until e2ee() is non-null, so this effect builds the bridge so the
	// connection can proceed encrypted.
	createEffect(() => {
		if (unmounted) return;
		if (rtc.status() !== "joined") return;
		if (e2ee() !== null) return;
		if (bridgeInitializing()) return;
		// Halt auto-retry after a failure: ensureBridge sets bridgeInitError
		// on failure and resets bridgeInitializing to false, which would
		// otherwise re-trigger this effect immediately and produce a tight
		// retry loop (a cached dynamic-import rejection in Vite/Rollup
		// resolves in milliseconds). Users on the joined-on-mount path have
		// no visible Join button to retry through, so absent some manual
		// recovery affordance the safest behavior is one attempt then stop.
		if (bridgeInitError() !== null) return;
		void ensureBridge();
	});

	const [confirmClose, setConfirmClose] = createSignal(false);

	let dialogRef: HTMLDivElement | undefined;
	let closeButtonRef: HTMLButtonElement | undefined;
	let previousFocus: HTMLElement | null = null;

	const requestClose = (): void => {
		// While a leave is in flight, ignore close requests. If the leave
		// fails server-side and the SDK reports we're still joined, the user
		// needs the overlay (and its error surface) to retry. `leaving()`
		// covers the window between `setLeaving(true)` and `rtc.status()`
		// flipping to "leaving" (after `await livekit.disconnect()`).
		if (leaving() || rtc.status() === "leaving") return;
		if (rtc.status() === "joined" || rtc.status() === "joining") {
			setConfirmClose(true);
			return;
		}
		props.onClose();
	};

	const confirmLeave = async (): Promise<void> => {
		// Single-flight: a second click on "Leave" while the first call is still
		// awaiting must not re-enter. rtc.leave() has a leavePending early-return,
		// so a second invocation would fall through to props.onClose() and tear
		// down the overlay even if the first attempt later fails and leaves the
		// user joined.
		if (leaving()) return;
		// Any retry clears the previous-attempt banner so we don't render two
		// alert nodes side-by-side once ConfirmDialog's internal handleConfirm
		// catch fills its own error slot.
		setLeaveError(null);
		// Flip `leaving` BEFORE any await so the LiveKit effect's disable
		// branch fires synchronously (epoch-gated teardown) and the
		// focus-change branch is unreachable until we finish. Defends
		// against a focus/membership tick landing between the two awaits
		// below from resurrecting the call. `leaveRequested` is sticky and
		// keeps LiveKit suppressed even after `leaving` clears in finally
		// — so a failed leave (status stays "joined") does NOT silently
		// resume mic publishing behind the user. The recovery path is the
		// ConfirmDialog's "Stay" button, which clears `leaveRequested` and
		// re-enables LiveKit. The direct "Leave call" button's onClick
		// handler opens the dialog on failure so this recovery path is
		// always available to the user.
		setLeaving(true);
		setLeaveRequested(true);
		try {
			// Eagerly disconnect LiveKit & stop the mic so the user gets instant
			// silence even if Matrix leave is slow or fails server-side.
			await livekit.disconnect();
			await rtc.leave();
			// rtc.leave() never rejects — it stores errors on rtc.error() and
			// reverts status to "joined" only when the SDK still reports joined.
			// Throw from here so ConfirmDialog keeps the dialog open and shows the
			// error instead of silently unmounting the overlay while the call is
			// live. For "error" (leave failed but session is no longer joined), we
			// let the overlay close — there's nothing for the user to retry.
			if (rtc.status() === "joined") {
				throw new Error(rtc.error()?.message ?? "Leave failed.");
			}
			// Dispose the E2EE bridge AFTER LiveKit disconnect + Matrix
			// leave have completed (or the throw above has propagated).
			// Terminating the worker earlier could surface errors during
			// in-flight decode/encode of the final teardown frames.
			// Disposal is idempotent so the onCleanup arm is safe.
			const ctx = e2ee();
			if (ctx) {
				ctx.dispose();
				setE2ee(null);
			}
			setConfirmClose(false);
			props.onClose();
		} finally {
			setLeaving(false);
		}
	};

	// Focus trap: keep keyboard users inside the dialog while it is open.
	// Unlike the iframe path, there is no cross-origin frame swallowing keys,
	// so a standard Tab/Shift+Tab cycle is sufficient.
	const handleDialogKeyDown = (e: KeyboardEvent): void => {
		if (e.key !== "Tab" || !dialogRef) return;
		// Defer to the inner ConfirmDialog's own focus trap while it is open;
		// otherwise this outer trap would also process the Tab and could pull
		// focus back into the background controls.
		if (confirmClose()) return;
		const focusable = Array.from(
			dialogRef.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
		);
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last?.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first?.focus();
		}
	};

	onMount(() => {
		previousFocus = document.activeElement as HTMLElement | null;
		queueMicrotask(() => closeButtonRef?.focus());
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape" && !confirmClose()) {
				e.preventDefault();
				requestClose();
			}
		};
		window.addEventListener("keydown", onKey);
		onCleanup(() => window.removeEventListener("keydown", onKey));
	});

	onCleanup(() => {
		if (previousFocus && document.body.contains(previousFocus)) {
			previousFocus.focus();
		}
		previousFocus = null;
		// E2EE bridge disposal happens via the earlier-registered
		// `onCleanup` (component top), which runs AFTER both
		// useLivekitRoom and useRtcSession teardown (SolidJS LIFO order).
	});

	const statusLabel = (): string => {
		switch (rtc.status()) {
			case "idle":
				return "Not joined";
			case "joining":
				return "Joining…";
			case "joined": {
				const err = rtc.error();
				return err ? `Joined (error: ${err.message})` : "Joined";
			}
			case "leaving":
				return "Leaving…";
			case "error":
				return `Error: ${rtc.error()?.message ?? "unknown"}`;
		}
	};

	return (
		<div
			ref={dialogRef}
			class="absolute inset-0 z-30 flex flex-col bg-surface-0"
			role="dialog"
			aria-modal="true"
			aria-label={`Native call in ${props.roomName}`}
			inert={cryptoDialogOpen() || undefined}
			tabIndex={-1}
			onKeyDown={handleDialogKeyDown}
		>
			<div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border-subtle bg-surface-1 px-4">
				<div class="flex min-w-0 items-center gap-2">
					<span
						aria-hidden="true"
						class="inline-block h-2 w-2 shrink-0 rounded-full bg-success"
					/>
					<span class="min-w-0 truncate text-sm font-semibold text-text-emphasis">
						Native call · {props.roomName}
					</span>
					<span class="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
						Dev preview
					</span>
				</div>
				<button
					type="button"
					ref={closeButtonRef}
					onClick={requestClose}
					disabled={rtc.status() === "leaving"}
					class="inline-flex h-8 w-8 items-center justify-center rounded text-text-disabled transition-colors hover:bg-surface-2 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-50 any-pointer-coarse:h-11 any-pointer-coarse:w-11"
					title="Close call"
					aria-label="Close call"
				>
					<svg
						class="h-4 w-4"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>
			</div>

			<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
				<div class="rounded border border-border-subtle bg-surface-1 p-4">
					<div class="text-xs uppercase tracking-wide text-text-disabled">
						Status
					</div>
					<div
						class="mt-1 text-sm text-text-emphasis"
						aria-live="polite"
						data-testid="rtc-status"
					>
						{statusLabel()}
					</div>
				</div>

				<div class="flex flex-wrap items-center gap-2">
					<Show
						when={rtc.status() !== "joined" && rtc.status() !== "leaving"}
						fallback={
							<>
								<button
									type="button"
									onClick={() =>
										void livekit.setLocalMuted(!livekit.localMuted())
									}
									disabled={
										livekit.status() !== "connecting" &&
										livekit.status() !== "connected"
									}
									aria-pressed={livekit.localMuted()}
									class="inline-flex items-center gap-2 rounded bg-surface-2 px-3 py-2 text-sm font-semibold text-text-emphasis transition-colors hover:bg-surface-3 disabled:opacity-50 any-pointer-coarse:min-h-11 any-pointer-coarse:py-3"
									title={livekit.localMuted() ? "Unmute" : "Mute"}
									aria-label={
										livekit.localMuted()
											? "Unmute microphone"
											: "Mute microphone"
									}
								>
									<svg
										class="h-4 w-4"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<Show
											when={livekit.localMuted()}
											fallback={
												<>
													<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
													<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
													<line x1="12" y1="19" x2="12" y2="23" />
													<line x1="8" y1="23" x2="16" y2="23" />
												</>
											}
										>
											<line x1="1" y1="1" x2="23" y2="23" />
											<path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
											<path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
											<line x1="12" y1="19" x2="12" y2="23" />
											<line x1="8" y1="23" x2="16" y2="23" />
										</Show>
									</svg>
									{livekit.localMuted() ? "Unmute" : "Mute"}
								</button>
								<button
									type="button"
									onClick={() =>
										void livekit.setLocalCamEnabled(!livekit.localCamEnabled())
									}
									disabled={livekit.status() !== "connected"}
									aria-pressed={livekit.localCamEnabled()}
									class="inline-flex items-center gap-2 rounded bg-surface-2 px-3 py-2 text-sm font-semibold text-text-emphasis transition-colors hover:bg-surface-3 disabled:opacity-50 any-pointer-coarse:min-h-11 any-pointer-coarse:py-3"
									title={
										livekit.localCamEnabled() ? "Stop camera" : "Start camera"
									}
									aria-label={
										livekit.localCamEnabled() ? "Stop camera" : "Start camera"
									}
								>
									<svg
										class="h-4 w-4"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
										aria-hidden="true"
									>
										<Show
											when={livekit.localCamEnabled()}
											fallback={
												<>
													<line x1="1" y1="1" x2="23" y2="23" />
													<path d="M21 21H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.5M9.5 4H15l2 2h4a2 2 0 0 1 2 2v9.5M13 13a3 3 0 1 1-4-4" />
												</>
											}
										>
											<path d="M23 7l-7 5 7 5V7z" />
											<rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
										</Show>
									</svg>
									{livekit.localCamEnabled() ? "Stop camera" : "Start camera"}
								</button>
								<button
									type="button"
									onClick={() => {
										confirmLeave().catch((err: unknown) => {
											setLeaveError(
												err instanceof Error ? err : new Error(String(err)),
											);
											// Failed direct leave: open the confirm
											// dialog so the user has explicit Retry
											// (Leave call) and recovery (Stay) actions.
											// The dialog body surfaces `leaveError`
											// inside the modal so the user sees what
											// went wrong without it being obscured by
											// the dialog backdrop.
											setConfirmClose(true);
										});
									}}
									disabled={leaving() || rtc.status() === "leaving"}
									class="rounded bg-danger-bg px-4 py-2 text-sm font-semibold text-danger-text disabled:opacity-50 any-pointer-coarse:min-h-11 any-pointer-coarse:py-3"
								>
									Leave call
								</button>
							</>
						}
					>
						<button
							type="button"
							onClick={() => {
								if (bridgeInitializing()) return;
								void (async () => {
									// Build the E2EE bridge BEFORE rtc.join() so
									// the bridge listener is wired before
									// joinRoomSession (Phase-4 invariant 2) and
									// the LiveKit Room sees the e2ee accessor as
									// non-null on its very first reactive read.
									const ok = await ensureBridge();
									if (!ok) return;
									if (unmounted) return;
									await rtc.join();
								})();
							}}
							disabled={
								!rtc.canJoin() ||
								rtc.status() === "joining" ||
								bridgeInitializing()
							}
							class="rounded bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-50 any-pointer-coarse:min-h-11 any-pointer-coarse:py-3"
						>
							{bridgeInitializing() ? "Preparing…" : "Join call"}
						</button>
					</Show>
				</div>

				<Show when={bridgeInitError() !== null}>
					<div
						role="alert"
						aria-live="assertive"
						class="rounded border border-danger-bg/40 bg-danger-bg/30 p-3 text-xs text-danger-text"
					>
						Could not initialise end-to-end encryption:{" "}
						{bridgeInitError()?.message ?? "Unknown error"}
					</div>
				</Show>

				<Show when={!rtc.canJoin() && rtc.joinBlockReason() !== null}>
					<div
						role="status"
						aria-live="polite"
						class="rounded border border-warning-border bg-warning-bg/60 p-3 text-xs text-warning-text"
					>
						{rtc.joinBlockReason()}
					</div>
				</Show>

				<Show when={livekit.error() !== null}>
					<div
						role="alert"
						class="rounded border border-danger-border bg-danger-bg/60 p-3 text-xs text-danger-text"
					>
						Audio: {livekit.error()?.message}
					</div>
				</Show>

				<Show when={livekit.audioBlocked()}>
					<div
						role="status"
						aria-live="polite"
						class="flex items-center justify-between gap-3 rounded border border-warning-border bg-warning-bg/60 p-3 text-xs text-warning-text"
					>
						<span>Your browser blocked audio playback. Click to enable.</span>
						<button
							type="button"
							onClick={() => void livekit.resumeAudio()}
							class="rounded bg-warning-text px-2 py-1 text-xs font-semibold text-warning-bg"
						>
							Enable audio
						</button>
					</div>
				</Show>

				<div class="rounded border border-border-subtle bg-surface-1 p-4">
					<div class="flex items-center justify-between">
						<div class="text-xs uppercase tracking-wide text-text-disabled">
							Participants (
							{livekit.participants().length || rtc.memberships().length})
						</div>
						<Show when={livekit.status() !== "idle"}>
							<div class="text-[10px] uppercase tracking-wide text-text-disabled">
								Audio: {livekit.status()}
							</div>
						</Show>
					</div>
					<Show
						when={livekit.participants().length > 0}
						fallback={
							<Show
								when={rtc.memberships().length > 0}
								fallback={
									<div class="mt-2 text-sm text-text-disabled">
										Nobody else has joined yet.
									</div>
								}
							>
								<ul class="mt-2 space-y-1 text-sm text-text-emphasis">
									<For each={rtc.memberships()}>
										{(m) => (
											<li class="font-mono text-xs">
												{m.userId} · device {m.deviceId}
											</li>
										)}
									</For>
								</ul>
							</Show>
						}
					>
						<div
							class="mt-2 grid auto-rows-fr gap-2"
							classList={{
								"grid-cols-1": livekit.participants().length <= 1,
								"grid-cols-2":
									livekit.participants().length >= 2 &&
									livekit.participants().length <= 4,
								"grid-cols-3": livekit.participants().length >= 5,
							}}
						>
							<For each={livekit.participants()}>
								{(p) => <ParticipantTile participant={p} livekit={livekit} />}
							</For>
						</div>
					</Show>
				</div>

				<p class="text-xs text-text-disabled">
					Native call (Phase 4 preview): audio + video, encrypted rooms
					supported. See issue #122 for the multi-phase plan.
				</p>
			</div>

			<ConfirmDialog
				open={confirmClose}
				onClose={() => {
					setConfirmClose(false);
					// User dismissed the dialog (e.g. clicked "Stay" after a
					// failed leave). Clear the sticky suppressor so the LiveKit
					// hook can reconnect if they are still joined, and clear
					// any captured direct-button leave error.
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
		</div>
	);
};

interface ParticipantTileProps {
	participant: RtcParticipant;
	livekit: LivekitRoomApi;
}

/**
 * Renders one participant in the call tile grid. Reactively attaches the
 * participant's current camera video track (if any) to a stable `<video>`
 * element via `track.attach(el)` and detaches on cleanup so LiveKit's
 * adaptive-stream logic correctly pauses when the tile unmounts.
 *
 * The element is always present in the DOM; we toggle visibility based on
 * whether a track is attached so the avatar placeholder doesn't overlap
 * the video frame. All `<video>` elements are `muted` — audio playback is
 * handled by the hidden `<audio>` attachments owned by the LiveKit hook,
 * which avoids local-mic loopback and improves autoplay reliability.
 */
const ParticipantTile: Component<ParticipantTileProps> = (props) => {
	let videoEl: HTMLVideoElement | undefined;
	const entry = createMemo(() =>
		props.livekit.videoTracks().get(props.participant.identity),
	);

	createEffect(() => {
		const e = entry();
		const el = videoEl;
		if (!el) return;
		if (!e) return;
		// Attaching to an existing element re-uses the same MediaStream sink
		// so the adaptive-stream "no consumer" pause doesn't trigger between
		// rapid track replacements (e.g. camera-device change).
		e.track.attach(el);
		onCleanup(() => {
			try {
				e.track.detach(el);
			} catch {
				// Track may already be stopped during teardown; safe to ignore.
			}
		});
	});

	return (
		<div
			class="relative flex aspect-video min-h-0 items-center justify-center overflow-hidden rounded border bg-surface-2"
			classList={{
				"border-success": props.participant.isSpeaking,
				"border-border-subtle": !props.participant.isSpeaking,
			}}
		>
			<video
				ref={videoEl}
				class="h-full w-full object-cover"
				classList={{ hidden: !entry() }}
				autoplay
				playsinline
				muted
			/>
			<Show when={!entry()}>
				<div
					aria-hidden="true"
					class="flex h-12 w-12 items-center justify-center rounded-full bg-surface-3 text-lg font-semibold text-text-emphasis"
				>
					{(props.participant.displayName.trim()[0] ?? "?").toUpperCase()}
				</div>
			</Show>
			<div class="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-black/40 px-2 py-1 text-xs text-white">
				<span class="min-w-0 truncate">
					{props.participant.displayName}
					<Show when={props.participant.isLocal}>
						<span class="ml-1 text-[10px] opacity-75">(you)</span>
					</Show>
				</span>
				<Show when={props.participant.isMuted}>
					<svg
						class="h-3.5 w-3.5 shrink-0"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						role="img"
						aria-label="Microphone muted"
					>
						<line x1="1" y1="1" x2="23" y2="23" />
						<path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
						<path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
					</svg>
				</Show>
			</div>
		</div>
	);
};
