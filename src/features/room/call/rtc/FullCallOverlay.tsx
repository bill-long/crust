import {
	type Component,
	createEffect,
	createMemo,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { cryptoDialogOpen } from "../../../../stores/cryptoActions";
import {
	toggleUserWantsMic,
	userWantsMic,
	micEnabled as voiceMicEnabled,
} from "../../../../stores/voice";
import { currentCallSession } from "./callSessionStore";
import type { LivekitRoomApi, RtcParticipant } from "./useLivekitRoom";

const FOCUSABLE_SELECTOR =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Pane-scoped chrome for the active call. Mounted inside the main-pane
 * container alongside `RoomPane`, gated on
 * `activeCallRoomId() === routeRoomId`, so it covers the room view
 * area but not the sidebars (sidebars remain interactive — the user
 * can navigate to other rooms during a call; PR B-2 will collapse the
 * overlay into a floating mini-widget on that path).
 *
 * Reads its session API from `currentCallSession()` and routes user
 * actions through it. Owns no lifecycle state — the hook ownership
 * lives in `CallSessionController`.
 *
 * Phase 7B note: this overlay still claims `role="dialog"
 * aria-modal="true"` and traps Tab, which is inconsistent with the
 * sidebars-stay-clickable UX (mouse users can leave, keyboard users
 * cannot). That tension is resolved in PR B-2 where the mini-widget
 * makes the non-modal semantics obvious. Keeping the existing modal
 * affordances for B-1 minimizes behavior delta on the lifecycle change.
 */
export const FullCallOverlay: Component = () => {
	const session = createMemo(() => currentCallSession());

	let dialogRef: HTMLDivElement | undefined;
	let leaveButtonRef: HTMLButtonElement | undefined;
	let previousFocus: HTMLElement | null = null;

	// Focus trap: keep keyboard users inside the dialog while it is open.
	const handleDialogKeyDown = (e: KeyboardEvent): void => {
		if (e.key !== "Tab" || !dialogRef) return;
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
		queueMicrotask(() => leaveButtonRef?.focus());
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				const s = session();
				if (!s) return;
				e.preventDefault();
				s.requestClose();
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
		const s = session();
		if (!s) return "Not joined";
		switch (s.rtc.status()) {
			case "idle":
				return "Not joined";
			case "joining":
				return "Joining…";
			case "joined": {
				const err = s.rtc.error();
				return err ? `Joined (error: ${err.message})` : "Joined";
			}
			case "leaving":
				return "Leaving…";
			case "error":
				return `Error: ${s.rtc.error()?.message ?? "unknown"}`;
		}
	};

	return (
		<Show when={session()}>
			{(s) => (
				<div
					ref={dialogRef}
					class="absolute inset-0 z-30 flex flex-col bg-surface-0"
					role="dialog"
					aria-modal="true"
					aria-label={`Native call in ${s().roomName()}`}
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
								Native call · {s().roomName()}
							</span>
							<span class="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
								Dev preview
							</span>
						</div>
						<button
							type="button"
							onClick={() => s().requestClose()}
							class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-text-disabled transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover any-pointer-coarse:h-11 any-pointer-coarse:w-11"
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
								when={
									s().rtc.status() !== "joined" &&
									s().rtc.status() !== "leaving"
								}
								fallback={
									<>
										<button
											type="button"
											onClick={toggleUserWantsMic}
											disabled={
												s().livekit.status() !== "connecting" &&
												s().livekit.status() !== "connected"
											}
											aria-pressed={!userWantsMic()}
											class="inline-flex items-center gap-2 rounded bg-surface-2 px-3 py-2 text-sm font-semibold text-text-emphasis transition-colors hover:bg-surface-3 disabled:opacity-50 any-pointer-coarse:min-h-11 any-pointer-coarse:py-3"
											title={userWantsMic() ? "Mute" : "Unmute"}
											aria-label={
												userWantsMic() ? "Mute microphone" : "Unmute microphone"
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
													when={!voiceMicEnabled()}
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
											{userWantsMic() ? "Mute" : "Unmute"}
										</button>
										<button
											type="button"
											onClick={() =>
												void s().livekit.setLocalCamEnabled(
													!s().livekit.localCamEnabled(),
												)
											}
											disabled={s().livekit.status() !== "connected"}
											aria-pressed={s().livekit.localCamEnabled()}
											class="inline-flex items-center gap-2 rounded bg-surface-2 px-3 py-2 text-sm font-semibold text-text-emphasis transition-colors hover:bg-surface-3 disabled:opacity-50 any-pointer-coarse:min-h-11 any-pointer-coarse:py-3"
											title={
												s().livekit.localCamEnabled()
													? "Stop camera"
													: "Start camera"
											}
											aria-label={
												s().livekit.localCamEnabled()
													? "Stop camera"
													: "Start camera"
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
													when={s().livekit.localCamEnabled()}
													fallback={
														<>
															<line x1="1" y1="1" x2="23" y2="23" />
															<path d="M21 21H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.5M9.5 4H15l2 2h4a2 2 0 0 1 2 2v9.5M13 13a3 3 0 1 1-4-4" />
														</>
													}
												>
													<path d="M23 7l-7 5 7 5V7z" />
													<rect
														x="1"
														y="5"
														width="15"
														height="14"
														rx="2"
														ry="2"
													/>
												</Show>
											</svg>
											{s().livekit.localCamEnabled()
												? "Stop camera"
												: "Start camera"}
										</button>
										<button
											type="button"
											ref={leaveButtonRef}
											onClick={() => {
												void s()
													.requestLeave()
													.catch(() => {
														// Controller surfaces the error inside its
														// ConfirmDialog; rejecting here is intentional
														// so the caller knows the direct path failed.
													});
											}}
											disabled={s().leaving() || s().rtc.status() === "leaving"}
											class="rounded bg-danger-bg px-4 py-2 text-sm font-semibold text-danger-text disabled:opacity-50 any-pointer-coarse:min-h-11 any-pointer-coarse:py-3"
										>
											Leave call
										</button>
									</>
								}
							>
								<button
									type="button"
									ref={leaveButtonRef}
									onClick={() => {
										void s().requestJoin();
									}}
									disabled={
										!s().rtc.canJoin() ||
										s().rtc.status() === "joining" ||
										s().bridgeInitializing()
									}
									class="rounded bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground disabled:opacity-50 any-pointer-coarse:min-h-11 any-pointer-coarse:py-3"
								>
									{s().bridgeInitializing() ? "Preparing…" : "Join call"}
								</button>
							</Show>
						</div>

						<Show when={s().bridgeInitError() !== null}>
							<div
								role="alert"
								aria-live="assertive"
								class="rounded border border-danger-bg/40 bg-danger-bg/30 p-3 text-xs text-danger-text"
							>
								Could not initialise end-to-end encryption:{" "}
								{s().bridgeInitError()?.message ?? "Unknown error"}
							</div>
						</Show>

						<Show
							when={!s().rtc.canJoin() && s().rtc.joinBlockReason() !== null}
						>
							<div
								role="status"
								aria-live="polite"
								class="rounded border border-warning-border bg-warning-bg/60 p-3 text-xs text-warning-text"
							>
								{s().rtc.joinBlockReason()}
							</div>
						</Show>

						<Show when={s().livekit.error() !== null}>
							<div
								role="alert"
								class="rounded border border-danger-border bg-danger-bg/60 p-3 text-xs text-danger-text"
							>
								Audio: {s().livekit.error()?.message}
							</div>
						</Show>

						<Show when={s().livekit.audioBlocked()}>
							<div
								role="status"
								aria-live="polite"
								class="flex items-center justify-between gap-3 rounded border border-warning-border bg-warning-bg/60 p-3 text-xs text-warning-text"
							>
								<span>
									Your browser blocked audio playback. Click to enable.
								</span>
								<button
									type="button"
									onClick={() => void s().livekit.resumeAudio()}
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
									{s().livekit.participants().length ||
										s().rtc.memberships().length}
									)
								</div>
								<Show when={s().livekit.status() !== "idle"}>
									<div class="text-[10px] uppercase tracking-wide text-text-disabled">
										Audio: {s().livekit.status()}
									</div>
								</Show>
							</div>
							<Show
								when={s().livekit.participants().length > 0}
								fallback={
									<Show
										when={s().rtc.memberships().length > 0}
										fallback={
											<div class="mt-2 text-sm text-text-disabled">
												Nobody else has joined yet.
											</div>
										}
									>
										<ul class="mt-2 space-y-1 text-sm text-text-emphasis">
											<For each={s().rtc.memberships()}>
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
										"grid-cols-1": s().livekit.participants().length <= 1,
										"grid-cols-2":
											s().livekit.participants().length >= 2 &&
											s().livekit.participants().length <= 4,
										"grid-cols-3": s().livekit.participants().length >= 5,
									}}
								>
									<For each={s().livekit.participants()}>
										{(p) => (
											<ParticipantTile participant={p} livekit={s().livekit} />
										)}
									</For>
								</div>
							</Show>
						</div>

						<p class="text-xs text-text-disabled">
							Native call (Phase 4 preview): audio + video, encrypted rooms
							supported. See issue #122 for the multi-phase plan.
						</p>
					</div>
				</div>
			)}
		</Show>
	);
};

interface ParticipantTileProps {
	participant: RtcParticipant;
	livekit: LivekitRoomApi;
}

/**
 * Renders one participant in the call tile grid. Reactively attaches
 * the participant's current camera video track (if any) to a stable
 * `<video>` element via `track.attach(el)` and detaches on cleanup so
 * LiveKit's adaptive-stream logic correctly pauses when the tile
 * unmounts.
 *
 * The element is always present in the DOM; we toggle visibility based
 * on whether a track is attached so the avatar placeholder doesn't
 * overlap the video frame. All `<video>` elements are `muted` — audio
 * playback is handled by the hidden `<audio>` attachments owned by the
 * LiveKit hook, which avoids local-mic loopback and improves autoplay
 * reliability.
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
