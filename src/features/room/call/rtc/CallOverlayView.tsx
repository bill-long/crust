import { type Component, createMemo, For, Show } from "solid-js";
import {
	createFailedImageUrls,
	createImageFallback,
} from "../../../../lib/imageFallback";
import type {
	CallOverlayParticipant,
	CallOverlaySnapshot,
} from "./callOverlayBridge";
import { MicStatusIcon } from "./MicStatusIcon";
import { ParticipantNameLabel } from "./ParticipantNameLabel";

interface CallOverlayViewProps {
	/** Latest call snapshot mirrored from the main window. */
	snapshot: CallOverlaySnapshot;
	/** Invoked when the user hangs up from the overlay (bridged to the main
	 *  window). Omit to hide the hang-up control. */
	onHangUp?: () => void;
	/** When true, use a translucent surface + backdrop blur so the chromeless,
	 *  transparent native overlay window lets the game behind it show through.
	 *  Defaults to an opaque panel (e.g. for a plain browser preview tab). */
	translucent?: boolean;
}

/**
 * Presentational call overlay panel for the standalone `/overlay` route (the
 * separate desktop overlay window). Unlike `CallOverlayPanel` — which is
 * rendered cross-window into a Document Picture-in-Picture document from the
 * opener's runtime and therefore must use non-delegated `on:` handlers — this
 * renders in its own ordinary document, so plain `onClick` is correct here.
 *
 * It is a pure view over the bridged `CallOverlaySnapshot`: it owns no call
 * state and reaches the SDK only indirectly via `onHangUp`.
 */
export const CallOverlayView: Component<CallOverlayViewProps> = (props) => {
	const active = createMemo(() => props.snapshot.active);
	// Fail-closed avatars, keyed by URL at the view level: each snapshot is
	// structurally cloned across the bridge, so participant identities are new
	// on every republish and per-row error state would never survive one (#457).
	const brokenAvatars = createFailedImageUrls();
	const participants = createMemo<readonly CallOverlayParticipant[]>(
		() => props.snapshot.participants,
	);
	const roomName = createMemo(() => props.snapshot.roomName || "Voice call");

	return (
		<div
			class="flex h-screen w-screen flex-col text-text-primary"
			classList={{
				"bg-surface-0": !props.translucent,
				"bg-surface-0/80 backdrop-blur-md": props.translucent,
			}}
		>
			<header
				data-tauri-drag-region
				class="flex h-10 shrink-0 select-none items-center justify-between gap-2 border-b border-border-subtle bg-surface-1 px-2"
			>
				<span class="flex min-w-0 items-center gap-1.5">
					<span
						aria-hidden="true"
						class="inline-block h-2 w-2 shrink-0 rounded-full"
						classList={{
							"bg-success": active(),
							"bg-text-disabled": !active(),
						}}
					/>
					<span class="min-w-0 truncate text-xs font-semibold text-text-emphasis">
						{active() ? roomName() : "No active call"}
					</span>
				</span>
				<Show when={active() && props.onHangUp}>
					{(hangUp) => (
						<button
							type="button"
							onClick={() => hangUp()()}
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
					)}
				</Show>
			</header>

			<Show
				when={active()}
				fallback={
					<div class="flex min-h-0 flex-1 items-center justify-center p-3 text-center text-xs text-text-disabled">
						You're not in a call.
					</div>
				}
			>
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
								const speaking = createMemo(() => p.isSpeaking && !p.isMuted);
								const avatar = createImageFallback(
									() => p.avatarUrl,
									brokenAvatars,
								);
								return (
									<li class="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-surface-1">
										<span class="relative shrink-0">
											<Show
												when={!avatar.failed() && p.avatarUrl}
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
														ref={avatar.ref}
														src={url()}
														alt=""
														aria-hidden="true"
														class="h-8 w-8 rounded-full object-cover"
														onError={avatar.onError}
														onLoad={avatar.onLoad}
													/>
												)}
											</Show>
											{/* Speaking ring — color only (no motion), safe under
											    prefers-reduced-motion. */}
											<span
												aria-hidden="true"
												class="pointer-events-none absolute inset-0 rounded-full ring-2 transition-colors"
												classList={{
													"ring-success": speaking(),
													"ring-transparent": !speaking(),
												}}
											/>
										</span>
										<ParticipantNameLabel
											participant={p}
											class="min-w-0 flex-1 truncate text-xs text-text-primary"
											youClass="ml-1 text-[10px] text-text-disabled"
										>
											<Show when={speaking()}>
												<span class="sr-only"> (speaking)</span>
											</Show>
										</ParticipantNameLabel>
										<MicStatusIcon
											muted={p.isMuted}
											micUnavailable={p.micUnavailable}
											isForeignSfu={p.isForeignSfu}
											mutedClass="text-danger-text"
										/>
									</li>
								);
							}}
						</For>
					</Show>
				</ul>
			</Show>
		</div>
	);
};
