import type { MatrixClient } from "matrix-js-sdk";
import {
	CryptoEvent,
	VerificationRequestEvent,
} from "matrix-js-sdk/lib/crypto-api";
import {
	canAcceptVerificationRequest,
	type VerificationRequest,
} from "matrix-js-sdk/lib/crypto-api/verification";
import { type Component, createSignal, onCleanup, Show } from "solid-js";
import { setCryptoTriggerElement } from "../../../stores/cryptoActions";

interface IncomingVerificationToastProps {
	client: MatrixClient;
	onAccept: (request: VerificationRequest) => void;
}

/**
 * Listens for CryptoEvent.VerificationRequestReceived and shows a toast
 * when an incoming verification request arrives. Accept or decline.
 * Tracks request phase changes to auto-dismiss if cancelled externally.
 */
const IncomingVerificationToast: Component<IncomingVerificationToastProps> = (
	props,
) => {
	const [pendingRequest, setPendingRequest] =
		createSignal<VerificationRequest | null>(null);

	// Element focused before the toast appeared. Used as the focus
	// restoration target after the verification dialog closes, since
	// the toast unmounts before the dialog renders.
	let focusBeforeToast: HTMLElement | null = null;

	// Restore focus to the captured pre-toast element (if still attached)
	// and clear the captured reference.
	const restoreCapturedFocus = (): void => {
		if (focusBeforeToast && document.body.contains(focusBeforeToast)) {
			focusBeforeToast.focus();
		}
		focusBeforeToast = null;
	};

	// Dismiss toast if the request is no longer acceptable
	const onRequestChange = (): void => {
		const req = pendingRequest();
		if (req && !canAcceptVerificationRequest(req)) {
			req.removeListener(VerificationRequestEvent.Change, onRequestChange);
			setPendingRequest(null);
			restoreCapturedFocus();
		}
	};

	const onVerificationRequest = (request: VerificationRequest): void => {
		if (!canAcceptVerificationRequest(request)) return;

		// Clean up listener on previous pending request
		const prev = pendingRequest();
		if (prev) {
			prev.removeListener(VerificationRequestEvent.Change, onRequestChange);
		}

		// Capture focus before the toast renders so we can restore it after
		// the verification dialog closes. Only capture on first toast — when
		// replacing an existing request, keep the original pre-toast focus
		// to avoid capturing a toast button that's about to unmount.
		if (!prev) {
			const active = document.activeElement;
			focusBeforeToast =
				active instanceof HTMLElement &&
				active !== document.body &&
				document.body.contains(active)
					? active
					: null;
		}

		setPendingRequest(request);
		request.on(VerificationRequestEvent.Change, onRequestChange);
	};

	props.client.on(
		CryptoEvent.VerificationRequestReceived,
		onVerificationRequest,
	);

	onCleanup(() => {
		props.client.removeListener(
			CryptoEvent.VerificationRequestReceived,
			onVerificationRequest,
		);
		const req = pendingRequest();
		if (req) {
			req.removeListener(VerificationRequestEvent.Change, onRequestChange);
		}
		focusBeforeToast = null;
	});

	const handleAccept = (): void => {
		const request = pendingRequest();
		if (!request) return;
		// Revalidate before accepting — request may have changed since toast appeared
		if (!canAcceptVerificationRequest(request)) {
			request.removeListener(VerificationRequestEvent.Change, onRequestChange);
			setPendingRequest(null);
			focusBeforeToast = null;
			return;
		}
		request.removeListener(VerificationRequestEvent.Change, onRequestChange);
		// Hand the focus restoration target to the crypto actions module so
		// restoreCryptoTriggerFocus() can return focus when the dialog closes.
		// Skip when null to avoid clobbering an existing trigger element.
		if (focusBeforeToast) {
			setCryptoTriggerElement(focusBeforeToast);
		}
		focusBeforeToast = null;
		setPendingRequest(null);
		props.onAccept(request);
	};

	const handleDecline = (): void => {
		const request = pendingRequest();
		if (request) {
			request.removeListener(VerificationRequestEvent.Change, onRequestChange);
			if (request.pending) {
				request.cancel().catch(() => {});
			}
		}
		setPendingRequest(null);
		// Restore focus directly since no dialog opens
		restoreCapturedFocus();
	};

	return (
		<Show when={pendingRequest()}>
			<div
				class="fixed bottom-4 right-4 z-50 w-80 rounded-lg border border-border-default bg-surface-1 p-4 shadow-xl"
				role="alert"
				aria-live="assertive"
			>
				<h3 class="mb-1 text-sm font-semibold text-text-primary">
					Verification request
				</h3>
				<p class="mb-3 text-xs text-text-muted">
					Another device wants to verify with you.
				</p>
				<div class="flex justify-end gap-2">
					<button
						type="button"
						onClick={handleDecline}
						class="rounded px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
					>
						Decline
					</button>
					<button
						type="button"
						onClick={handleAccept}
						class="rounded bg-success px-3 py-1.5 text-xs font-semibold text-text-primary transition-colors hover:bg-success-hover"
					>
						Accept
					</button>
				</div>
			</div>
		</Show>
	);
};

export { IncomingVerificationToast };
