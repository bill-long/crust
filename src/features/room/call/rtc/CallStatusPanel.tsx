import { useNavigate } from "@solidjs/router";
import { type Component, createMemo, Show } from "solid-js";
import { useDecodedParams } from "../../../../app/useDecodedParams";
import type { SummariesStore } from "../../../../client/summaries";
import { activeCallRoomId } from "../../../../stores/activeCall";
import { cryptoDialogOpen } from "../../../../stores/cryptoActions";
import { appModalOpen } from "../../../../stores/modalStack";
import { currentCallSession } from "./callSessionStore";
import { pickReturnToCallRoute } from "./returnToCallRoute";

/**
 * Discord-style "Voice Connected" panel docked above `UserBar` in the
 * sidebar column while a call is active. Replaces the floating
 * `MiniCallWidget` (deleted in this PR). Discord shows its call-status
 * row regardless of which channel the user is currently viewing, so
 * the panel renders whenever an active call exists — even when the
 * user is on the call's own room (where `FullCallOverlay` already
 * covers the main pane). The sidebar column is independent of the
 * main pane, so both surfaces co-exist without overlap.
 *
 * Responsibilities:
 *
 *   - Status label derived from `rtc.status()` so the user can see
 *     joining / joined / leaving / errored without opening the
 *     overlay.
 *   - Clickable status block → navigates back to the call's room via
 *     `pickReturnToCallRoute` (DM vs current-space vs home fallback).
 *   - Disconnect button → delegates to `session.requestClose()` which
 *     opens the leave-confirm dialog owned by `CallSessionController`
 *     (same dialog `FullCallOverlay` uses, so the leave flow is
 *     identical across surfaces).
 *
 * Owns no lifecycle state — purely a view over `currentCallSession()`
 * and `activeCallRoomId()`. The session lifecycle is owned by
 * `CallSessionController` mounted in `PersistentCallSurface` (above
 * the per-route `Layout`), so this panel can mount inside `Layout`
 * without risking the "click Return → silently kill the call" bug
 * fixed in PR #155: navigation may remount the panel, but it owns no
 * call state to lose.
 *
 * `inert` whenever an app modal or crypto dialog is open, matching the
 * defense-in-depth approach used by `FullCallOverlay`.
 *
 * Mic mute is intentionally NOT duplicated here — `UserBar` already
 * owns the global mic toggle directly below this panel.
 */

interface CallStatusPanelProps {
	summaries: SummariesStore;
}

type CallStatusKind = "joining" | "joined" | "leaving" | "error" | "idle";

interface StatusInfo {
	label: string;
	kind: CallStatusKind;
}

export const CallStatusPanel: Component<CallStatusPanelProps> = (props) => {
	const navigate = useNavigate();
	const params = useDecodedParams<{ roomId?: string; spaceId?: string }>();
	const routeSpaceId = (): string | undefined => params.spaceId;

	const session = createMemo(() => currentCallSession());

	// Only render when there's both an active call AND a published
	// session, and they agree on the room id. During keyed controller
	// transitions the two stores could disagree for a tick; rendering
	// off a mismatched pair would surface stale chrome.
	const visibleSession = createMemo(() => {
		const callRoomId = activeCallRoomId();
		const s = session();
		if (callRoomId === null || s === null) return null;
		if (s.roomId !== callRoomId) return null;
		return s;
	});

	const inert = (): boolean => appModalOpen() || cryptoDialogOpen();

	const statusInfo = (
		s: NonNullable<ReturnType<typeof session>>,
	): StatusInfo => {
		switch (s.rtc.status()) {
			case "idle":
				return { label: "Not joined", kind: "idle" };
			case "joining":
				return { label: "Connecting…", kind: "joining" };
			case "joined": {
				const err = s.rtc.error();
				return err
					? { label: "Connected (error)", kind: "error" }
					: { label: "Voice Connected", kind: "joined" };
			}
			case "leaving":
				return { label: "Leaving…", kind: "leaving" };
			case "error":
				return { label: "Error", kind: "error" };
		}
	};

	const dotClass = (kind: CallStatusKind): string => {
		switch (kind) {
			case "joined":
				return "bg-success";
			case "joining":
				return "bg-warning animate-pulse";
			case "leaving":
				return "bg-text-disabled";
			case "error":
				return "bg-danger-text";
			case "idle":
				return "bg-text-disabled";
		}
	};

	const labelTextClass = (kind: CallStatusKind): string => {
		switch (kind) {
			case "joined":
				return "text-success";
			case "joining":
				return "text-warning-text";
			case "leaving":
				return "text-text-disabled";
			case "error":
				return "text-danger-text";
			case "idle":
				return "text-text-disabled";
		}
	};

	const handleReturn = (s: NonNullable<ReturnType<typeof session>>): void => {
		// Recompute route at click time so an in-flight space change is
		// honoured instead of using a snapshot from mount.
		const route = pickReturnToCallRoute(
			props.summaries,
			s.roomId,
			routeSpaceId(),
		);
		navigate(route);
	};

	const handleLeave = (s: NonNullable<ReturnType<typeof session>>): void => {
		s.requestClose();
	};

	return (
		<Show when={visibleSession()}>
			{(s) => {
				const info = createMemo(() => statusInfo(s()));
				return (
					<aside
						aria-label={`Active call in ${s().roomName()}`}
						inert={inert() || undefined}
						data-testid="call-status-panel"
						class="flex h-12 shrink-0 items-center gap-2 border-t border-border-subtle bg-surface-1 px-2"
					>
						<button
							type="button"
							onClick={() => handleReturn(s())}
							title="Return to the call's room"
							aria-label={`Return to call in ${s().roomName()}`}
							class="flex h-full min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover any-pointer-coarse:min-h-11"
						>
							<span
								aria-hidden="true"
								class={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass(info().kind)}`}
							/>
							<span class="flex min-w-0 flex-col">
								<span
									class={`min-w-0 truncate text-xs font-semibold ${labelTextClass(info().kind)}`}
									aria-live="polite"
									data-testid="call-status-label"
								>
									{info().label}
								</span>
								<span class="min-w-0 truncate text-xs text-text-disabled">
									{s().roomName()}
								</span>
							</span>
						</button>
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								handleLeave(s());
							}}
							disabled={s().leaving() || s().rtc.status() === "leaving"}
							title="Disconnect from the call"
							aria-label="Disconnect from call"
							class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded text-danger-text transition-colors hover:bg-danger-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover disabled:opacity-50 any-pointer-coarse:h-11 any-pointer-coarse:w-11"
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
								{/* Phone-down (hang up) icon */}
								<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
								<line x1="23" y1="1" x2="1" y2="23" />
							</svg>
						</button>
					</aside>
				);
			}}
		</Show>
	);
};
