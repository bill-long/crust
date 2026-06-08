import { type Component, createMemo, For, Show } from "solid-js";
import { micEnabled as voiceMicEnabled } from "../../../../stores/voice";
import { currentCallSession } from "./callSessionStore";
import type { RtcParticipant } from "./useLivekitRoom";

/**
 * The compact "voice overlay" panel rendered INSIDE the Document
 * Picture-in-Picture window (a separate, same-origin document). It mirrors the
 * active call's participants so the user can see who is connected, who is
 * talking, and who is muted without alt-tabbing out of a full-screen app.
 *
 * Cross-window notes (this component is unusual — read before editing):
 *
 *   - It is rendered via `render()` into `pipWindow.document.body` by
 *     `CallOverlayController`, but from the *opener's* Solid runtime, so the
 *     module-level signals it reads (`currentCallSession()`,
 *     `voiceMicEnabled()`) stay reactive across the window boundary.
 *   - Solid delegates events like `onClick` to the OPENER document, which never
 *     receives events from the PiP document. So every interactive handler here
 *     MUST use the non-delegated `on:click` / `on:keydown` namespaced form, or
 *     it will silently never fire. Do not switch these to `onClick`.
 *
 * Local mic state is read from the voice store (`voiceMicEnabled()`) rather than
 * the local participant's LiveKit `isMuted`, so push-to-mute / push-to-talk
 * crosses out the mic instantly — matching `FullCallOverlay`'s mute button and
 * `UserBar`. Remote participants use their LiveKit `isMuted`.
 */
export const CallOverlayPanel: Component = () => {
	const session = createMemo(() => currentCallSession());
	const participants = createMemo<readonly RtcParticipant[]>(
		() => session()?.livekit.participants() ?? [],
	);
	const roomName = createMemo(() => session()?.roomName() ?? "Voice call");

	// Local mic: the voice store is the responsive source of truth (reflects
	// push-to-mute/push-to-talk immediately). Remote: LiveKit publication state.
	const isMuted = (p: RtcParticipant): boolean =>
		p.isLocal ? !voiceMicEnabled() : p.isMuted;

	const handleHangUp = (): void => {
		const s = session();
		if (!s) return;
		// Direct leave (no confirmation dialog): a ConfirmDialog would render in
		// the hidden opener window, unusable from the overlay over a full-screen
		// app. The controller still surfaces leave errors in the opener.
		void s.requestLeave().catch(() => {
			// Controller surfaces the error in its ConfirmDialog; nothing to do.
		});
	};

	return (
		<div class="flex h-screen w-screen flex-col bg-surface-0 text-text-primary">
			<header class="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border-subtle bg-surface-1 px-2">
				<span class="flex min-w-0 items-center gap-1.5">
					<span
						aria-hidden="true"
						class="inline-block h-2 w-2 shrink-0 rounded-full bg-success"
					/>
					<span class="min-w-0 truncate text-xs font-semibold text-text-emphasis">
						{roomName()}
					</span>
				</span>
				<button
					type="button"
					on:click={handleHangUp}
					title="Disconnect from the call"
					aria-label="Disconnect from call"
					class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-danger-text transition-colors hover:bg-danger-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover"
				>
					<svg
						class="h-3.5 w-3.5"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true"
					>
						{/* Phone-down (hang up) */}
						<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
						<line x1="23" y1="1" x2="1" y2="23" />
					</svg>
				</button>
			</header>

			<ul class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-1.5">
				<Show
					when={participants().length > 0}
					fallback={
						<li class="px-2 py-3 text-center text-xs text-text-disabled">
							Nobody has joined yet.
						</li>
					}
				>
					<For each={participants()}>
						{(p) => {
							const muted = createMemo(() => isMuted(p));
							const speaking = createMemo(() => p.isSpeaking && !muted());
							return (
								<li class="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-1">
									<span class="relative shrink-0">
										<Show
											when={p.avatarUrl}
											fallback={
												<span
													aria-hidden="true"
													class="flex h-8 w-8 items-center justify-center rounded-full bg-surface-3 text-xs font-semibold text-text-emphasis"
												>
													{(p.displayName.trim()[0] ?? "?").toUpperCase()}
												</span>
											}
										>
											{(url) => (
												<img
													src={url()}
													alt=""
													aria-hidden="true"
													class="h-8 w-8 rounded-full object-cover"
												/>
											)}
										</Show>
										{/* Speaking ring — color only (no motion), so it is safe
										    under prefers-reduced-motion. */}
										<span
											aria-hidden="true"
											class="pointer-events-none absolute inset-0 rounded-full ring-2 transition-colors"
											classList={{
												"ring-success": speaking(),
												"ring-transparent": !speaking(),
											}}
										/>
									</span>
									<span class="min-w-0 flex-1 truncate text-xs text-text-primary">
										{p.displayName}
										<Show when={p.isLocal}>
											<span class="ml-1 text-[10px] text-text-disabled">
												(you)
											</span>
										</Show>
										{/* Non-color cue for speaking state (the ring is
										    aria-hidden) so it isn't conveyed by color alone. */}
										<Show when={speaking()}>
											<span class="sr-only"> (speaking)</span>
										</Show>
									</span>
									<Show when={muted()}>
										<svg
											class="h-3.5 w-3.5 shrink-0 text-danger-text"
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
							);
						}}
					</For>
				</Show>
			</ul>
		</div>
	);
};
