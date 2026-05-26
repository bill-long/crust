import {
	type Component,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { useClient } from "../../../../client/client";
import { cryptoDialogOpen } from "../../../../stores/cryptoActions";
import { ConfirmDialog } from "../../settings/ConfirmDialog";
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

	const [confirmClose, setConfirmClose] = createSignal(false);
	let dialogRef: HTMLDivElement | undefined;
	let closeButtonRef: HTMLButtonElement | undefined;
	let previousFocus: HTMLElement | null = null;

	const requestClose = (): void => {
		if (rtc.status() === "joined" || rtc.status() === "joining") {
			setConfirmClose(true);
			return;
		}
		props.onClose();
	};

	const confirmLeave = async (): Promise<void> => {
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
			case "joined":
				return "Joined";
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
					class="inline-flex h-8 w-8 items-center justify-center rounded text-text-disabled transition-colors hover:bg-surface-2 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover any-pointer-coarse:h-11 any-pointer-coarse:w-11"
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

				<div class="flex gap-2">
					<Show
						when={rtc.status() !== "joined" && rtc.status() !== "leaving"}
						fallback={
							<button
								type="button"
								onClick={() => void rtc.leave()}
								disabled={rtc.status() === "leaving"}
								class="rounded bg-danger-bg px-4 py-2 text-sm font-semibold text-danger-text disabled:opacity-50 any-pointer-coarse:min-h-11 any-pointer-coarse:py-3"
							>
								Leave call
							</button>
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

				<Show when={!rtc.canJoin() && rtc.status() !== "error"}>
					<div
						role="status"
						aria-live="polite"
						class="rounded border border-warning-border bg-warning-bg/60 p-3 text-xs text-warning-text"
					>
						Cannot join: no MatrixRTC foci configured. Set
						<code class="mx-1">elementCall.url</code> in config.json.
					</div>
				</Show>

				<div class="rounded border border-border-subtle bg-surface-1 p-4">
					<div class="text-xs uppercase tracking-wide text-text-disabled">
						Participants ({rtc.memberships().length})
					</div>
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
				</div>

				<p class="text-xs text-text-disabled">
					Phase 1 preview: membership-only join (no audio/video). See issue #122
					for the multi-phase plan.
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
