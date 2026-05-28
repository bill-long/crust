import {
	type Component,
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
import { useLivekitRoom } from "./useLivekitRoom";
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
	const rtc = useRtcSession({
		client,
		roomId: props.roomId,
		elementCallUrl: props.elementCallUrl,
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
	const [leaving, setLeaving] = createSignal(false);

	const livekit = useLivekitRoom({
		client,
		focus: rtc.activeFocus,
		// Only connect once we're actually joined; teardown if leaving/error.
		enabled: createMemo(
			() =>
				!leaving() && rtc.status() === "joined" && rtc.activeFocus() !== null,
		),
		memberships: rtc.memberships,
		audioDeviceId: createMemo(() => userSettings().rtcMicDeviceId),
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
		// Flip `leaving` BEFORE any await so the LiveKit effect's disable
		// branch fires synchronously (epoch-gated teardown) and the
		// focus-change branch is unreachable until we finish. Defends
		// against a focus/membership tick landing between the two awaits
		// below from resurrecting the call.
		setLeaving(true);
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
									onClick={() => void confirmLeave()}
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
							onClick={() => void rtc.join()}
							disabled={!rtc.canJoin() || rtc.status() === "joining"}
							class="rounded bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-50 any-pointer-coarse:min-h-11 any-pointer-coarse:py-3"
						>
							Join call
						</button>
					</Show>
				</div>

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
						<ul class="mt-2 space-y-1.5 text-sm text-text-emphasis">
							<For each={livekit.participants()}>
								{(p) => (
									<li class="flex items-center gap-2">
										<span
											aria-hidden="true"
											class="inline-block h-2 w-2 shrink-0 rounded-full"
											classList={{
												"bg-success": p.isSpeaking,
												"bg-surface-3": !p.isSpeaking,
											}}
										/>
										<span class="min-w-0 flex-1 truncate">
											{p.displayName}
											<Show when={p.isLocal}>
												<span class="ml-1 text-xs text-text-disabled">
													(you)
												</span>
											</Show>
										</span>
										<Show when={p.isMuted}>
											<svg
												class="h-3.5 w-3.5 text-text-disabled"
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
									</li>
								)}
							</For>
						</ul>
					</Show>
				</div>

				<p class="text-xs text-text-disabled">
					Phase 2 preview: audio only, unencrypted rooms. See issue #122 for the
					multi-phase plan.
				</p>
			</div>

			<ConfirmDialog
				open={confirmClose}
				onClose={() => setConfirmClose(false)}
				title="Leave call?"
				body="Closing this panel will end your participation in the call. You can rejoin from the room header at any time."
				confirmLabel="Leave call"
				cancelLabel="Stay"
				destructive
				onConfirm={confirmLeave}
			/>
		</div>
	);
};
