import { type Component, createSignal, onCleanup, onMount } from "solid-js";
import { cryptoDialogOpen } from "../../../stores/cryptoActions";
import { ConfirmDialog } from "../settings/ConfirmDialog";

interface CallOverlayProps {
	/** Operator-deployed Element Call instance URL (e.g. https://call.example.com). */
	elementCallUrl: string;
	/** Matrix room id to join. Snapshotted by the caller so route changes
	 *  don't reassign the iframe mid-call. */
	roomId: string;
	/** Human-readable room name shown in the overlay header. */
	roomName: string;
	onClose: () => void;
}

/**
 * Full-pane modal hosting an embedded Element Call iframe.
 *
 * v1 limitation: this uses Element Call's standalone (no-widget) URL form,
 * so the user authenticates separately inside the iframe on the operator's
 * Element Call origin. A future revision can hand off Matrix credentials via
 * the widget API to skip the second login.
 *
 * The iframe is unmounted on close; route navigation closes the overlay via
 * the caller's keyed <Show>, matching the v1 "no mini call widget" decision.
 */
export const CallOverlay: Component<CallOverlayProps> = (props) => {
	const [confirmClose, setConfirmClose] = createSignal(false);
	let closeButtonRef: HTMLButtonElement | undefined;
	let previousFocus: HTMLElement | null = null;

	const callSrc = (): string => {
		const base = props.elementCallUrl.replace(/\/+$/, "");
		return `${base}/room/#?roomId=${encodeURIComponent(props.roomId)}`;
	};

	const requestClose = (): void => {
		setConfirmClose(true);
	};

	// Esc to request close. Listens on window so it works regardless of
	// where focus is in the parent document (the iframe itself swallows
	// key events when focus is inside it — that's an accepted v1 limit).
	onMount(() => {
		previousFocus = document.activeElement as HTMLElement | null;
		// Move focus into the dialog so keyboard users land on a control
		// they can act on. Matches ConfirmDialog's pattern.
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
		// Restore focus to whatever opened the overlay (typically the
		// CallButton in the room header).
		if (previousFocus && document.body.contains(previousFocus)) {
			previousFocus.focus();
		}
		previousFocus = null;
	});

	return (
		<div
			class="absolute inset-0 z-30 flex flex-col bg-surface-0"
			role="dialog"
			aria-modal="true"
			aria-label={`Call in ${props.roomName}`}
			inert={cryptoDialogOpen() || undefined}
		>
			<div class="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border-subtle bg-surface-1 px-4">
				<div class="flex min-w-0 items-center gap-2">
					<span
						aria-hidden="true"
						class="inline-block h-2 w-2 shrink-0 rounded-full bg-success"
					/>
					<span class="min-w-0 truncate text-sm font-semibold text-text-emphasis">
						Call · {props.roomName}
					</span>
				</div>
				<button
					type="button"
					ref={closeButtonRef}
					onClick={requestClose}
					class="inline-flex h-8 w-8 items-center justify-center rounded text-text-disabled transition-colors hover:bg-surface-2 hover:text-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover any-pointer-coarse:h-11 any-pointer-coarse:w-11"
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

			{/*
			 * Sandbox tokens (defense in depth — operator-deployed Element Call
			 * origin is already trusted via CSP `frame-src`):
			 *   allow-scripts                  — Element Call is a SPA
			 *   allow-same-origin              — preserves the iframe's OWN
			 *                                    origin (vs. forcing an opaque
			 *                                    one) so it can use IndexedDB
			 *                                    / SW / localStorage for crypto
			 *                                    state. Element Call requires
			 *                                    this to function.
			 *                                    CAVEAT: combined with
			 *                                    allow-scripts, this provides
			 *                                    meaningful isolation ONLY when
			 *                                    `elementCall.url` is on a
			 *                                    different origin than this
			 *                                    app. config.ts does not
			 *                                    enforce that; operators who
			 *                                    deploy Element Call at the
			 *                                    same origin as the client
			 *                                    will get effectively NO
			 *                                    sandbox isolation (the framed
			 *                                    page can reach parent.document,
			 *                                    remove the iframe's sandbox
			 *                                    attribute, and reload itself
			 *                                    unsandboxed, as MDN warns).
			 *                                    Such an operator already
			 *                                    trusts both surfaces (they
			 *                                    deployed both), so this is an
			 *                                    accepted deployment caveat:
			 *                                    the defense-in-depth gain
			 *                                    here is reserved for the
			 *                                    typical separate-origin
			 *                                    deployment.
			 *   allow-popups + allow-popups-to-escape-sandbox
			 *                                  — SSO / external-auth popups
			 *   allow-forms                    — login form submission
			 * Intentionally omitted: allow-top-navigation (the primary risk
			 * this sandbox is mitigating), allow-modals, allow-downloads,
			 * allow-pointer-lock, allow-presentation (the Presentation API
			 * is for casting via navigator.presentation; screen sharing uses
			 * getDisplayMedia which is gated by the `display-capture`
			 * Permissions Policy in the `allow=` attribute above). Add only
			 * if a documented Element Call flow is observed breaking.
			 */}
			<iframe
				title={`Element Call — ${props.roomName}`}
				src={callSrc()}
				class="min-h-0 flex-1 border-0 bg-surface-0"
				allow="camera; microphone; autoplay; clipboard-write; display-capture; fullscreen; screen-wake-lock"
				sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
				referrerPolicy="no-referrer"
			/>

			<ConfirmDialog
				open={confirmClose}
				onClose={() => setConfirmClose(false)}
				title="Leave call?"
				body="Closing this panel will end your participation in the call. You can rejoin from the room header at any time."
				confirmLabel="Leave call"
				cancelLabel="Stay"
				destructive
				onConfirm={() => {
					setConfirmClose(false);
					props.onClose();
				}}
			/>
		</div>
	);
};
