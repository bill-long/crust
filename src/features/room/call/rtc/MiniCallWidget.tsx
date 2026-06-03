import { useNavigate } from "@solidjs/router";
import { type Component, createMemo, Show } from "solid-js";
import { useDecodedParams } from "../../../../app/useDecodedParams";
import type { SummariesStore } from "../../../../client/summaries";
import { activeCallRoomId } from "../../../../stores/activeCall";
import { cryptoDialogOpen } from "../../../../stores/cryptoActions";
import { appModalOpen } from "../../../../stores/modalStack";
import {
	toggleUserWantsMic,
	userWantsMic,
	micEnabled as voiceMicEnabled,
} from "../../../../stores/voice";
import { currentCallSession } from "./callSessionStore";
import { pickReturnToCallRoute } from "./returnToCallRoute";

/**
 * Floating mini call widget (Phase 7B PR B-2b of #122 — closes #99
 * bullet 4 follow-through). Pinned to the viewport bottom-right while
 * a call is active AND the user is currently viewing a different
 * route than the call's room. Provides:
 *
 *   - A status label derived from `rtc.status()` so the user always
 *     knows whether the call is joining / joined / leaving / errored
 *     even when the full overlay is offscreen.
 *   - A mic mute toggle wired to the shared voice store (same intent
 *     surface as the in-call mute button and the UserBar mic icon).
 *   - "Return to call" — navigates back to the call's room via the
 *     route picker (DM vs current-space vs home; never produces
 *     `/space/X/Y` unless Y is a direct child of X).
 *   - "Leave" — delegates to `session.requestClose()` which opens the
 *     leave-confirm dialog owned by `CallSessionController` (the same
 *     dialog the full overlay uses), so the actual leave flow is
 *     identical regardless of which surface initiated it.
 *
 * Layered semantics:
 *
 *   - `z-30`, intentionally BELOW app modals (`SettingsOverlay`,
 *     `RoomSettingsOverlay`, etc. live at `z-40+`). When the user
 *     opens Settings the widget is visually covered; the user closes
 *     Settings (or navigates) before interacting with the widget
 *     again. This mirrors the rule applied to `FullCallOverlay` and
 *     keeps the modal's focus trap unbroken.
 *   - `inert` whenever ANY app modal OR a crypto dialog is open, as
 *     defense-in-depth even though the widget is also covered by the
 *     modal's z-index. Without `inert`, pointer events firing under
 *     a partial modal backdrop would still reach the widget.
 *
 * Owns no lifecycle state of its own — every signal read goes through
 * `currentCallSession()`, `activeCallRoomId()`, the voice store, and
 * the route params, so the widget is purely a view over the global
 * call surface.
 */

interface MiniCallWidgetProps {
	summaries: SummariesStore;
}

export const MiniCallWidget: Component<MiniCallWidgetProps> = (props) => {
	const navigate = useNavigate();
	const params = useDecodedParams<{ roomId?: string; spaceId?: string }>();

	const routeRoomId = (): string | undefined => params.roomId;
	const routeSpaceId = (): string | undefined => params.spaceId;

	const session = createMemo(() => currentCallSession());

	// Only show when there IS an active call AND the user is NOT
	// currently viewing the call's room. The controller is hoisted at
	// Layout level so it survives navigation; the widget is the user's
	// only handle on the call while they are away from its room.
	const shouldShow = createMemo(() => {
		const callRoomId = activeCallRoomId();
		if (callRoomId === null) return false;
		if (session() === null) return false;
		// Compare against the route, NOT against the widget's own state.
		// While viewing the call's room, the FullCallOverlay covers the
		// main pane — the mini-widget would be redundant chrome.
		return callRoomId !== (routeRoomId() ?? null);
	});

	const inert = (): boolean => appModalOpen() || cryptoDialogOpen();

	const statusLabel = (s: NonNullable<ReturnType<typeof session>>): string => {
		switch (s.rtc.status()) {
			case "idle":
				return "Not joined";
			case "joining":
				return "Connecting…";
			case "joined": {
				const err = s.rtc.error();
				return err ? "Connected (error)" : "Connected";
			}
			case "leaving":
				return "Leaving…";
			case "error":
				return "Error";
		}
	};

	const handleReturn = (s: NonNullable<ReturnType<typeof session>>): void => {
		// Recompute the route at click time so an in-flight navigation
		// (e.g. user switched spaces while the widget was visible) is
		// honoured instead of using a snapshot from mount.
		const route = pickReturnToCallRoute(
			props.summaries,
			s.roomId,
			routeSpaceId(),
		);
		navigate(route);
	};

	const handleLeave = (s: NonNullable<ReturnType<typeof session>>): void => {
		// Same leave path as the full overlay: requestClose either opens
		// the leave-confirm ConfirmDialog (when joined/joining) or
		// directly clears `activeCallRoomId` (when still idle/error).
		s.requestClose();
	};

	return (
		<Show when={shouldShow() ? session() : null}>
			{(s) => (
				<aside
					aria-label={`Active call in ${s().roomName()}`}
					inert={inert() || undefined}
					class="fixed bottom-4 right-4 z-30 flex max-w-sm items-center gap-2 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 shadow-lg"
				>
					<span
						aria-hidden="true"
						class="inline-block h-2 w-2 shrink-0 rounded-full bg-success"
					/>
					<div class="flex min-w-0 flex-col">
						<span class="min-w-0 truncate text-sm font-semibold text-text-emphasis">
							{s().roomName()}
						</span>
						<span
							class="min-w-0 truncate text-xs text-text-disabled"
							aria-live="polite"
							data-testid="mini-call-status"
						>
							{statusLabel(s())}
						</span>
					</div>

					<div class="ml-2 flex shrink-0 items-center gap-1">
						<button
							type="button"
							onClick={toggleUserWantsMic}
							aria-pressed={!userWantsMic()}
							aria-label={
								userWantsMic() ? "Mute microphone" : "Unmute microphone"
							}
							title={userWantsMic() ? "Mute" : "Unmute"}
							class="inline-flex h-9 w-9 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover any-pointer-coarse:h-11 any-pointer-coarse:w-11"
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
						</button>
						<button
							type="button"
							onClick={() => handleReturn(s())}
							class="inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover any-pointer-coarse:min-h-11 any-pointer-coarse:py-3"
							title="Return to the call's room"
							aria-label="Return to call"
						>
							Return
						</button>
						<button
							type="button"
							onClick={() => handleLeave(s())}
							disabled={s().leaving() || s().rtc.status() === "leaving"}
							class="inline-flex items-center gap-1 rounded bg-danger-bg px-3 py-1.5 text-xs font-semibold text-danger-text disabled:opacity-50 any-pointer-coarse:min-h-11 any-pointer-coarse:py-3"
							title="Leave the call"
							aria-label="Leave call"
						>
							Leave
						</button>
					</div>
				</aside>
			)}
		</Show>
	);
};
