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

	// Dismiss toast if the request is no longer acceptable
	const onRequestChange = (): void => {
		const req = pendingRequest();
		if (req && !canAcceptVerificationRequest(req)) {
			req.removeListener(VerificationRequestEvent.Change, onRequestChange);
			setPendingRequest(null);
		}
	};

	const onVerificationRequest = (request: VerificationRequest): void => {
		if (!canAcceptVerificationRequest(request)) return;

		// Clean up listener on previous pending request
		const prev = pendingRequest();
		if (prev) {
			prev.removeListener(VerificationRequestEvent.Change, onRequestChange);
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
	});

	const handleAccept = (): void => {
		const request = pendingRequest();
		if (!request) return;
		// Revalidate before accepting — request may have changed since toast appeared
		if (!canAcceptVerificationRequest(request)) {
			request.removeListener(VerificationRequestEvent.Change, onRequestChange);
			setPendingRequest(null);
			return;
		}
		request.removeListener(VerificationRequestEvent.Change, onRequestChange);
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
	};

	return (
		<Show when={pendingRequest()}>
			<div
				class="fixed bottom-4 right-4 z-50 w-80 rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-xl"
				role="alert"
				aria-live="assertive"
			>
				<h3 class="mb-1 text-sm font-semibold text-white">
					Verification request
				</h3>
				<p class="mb-3 text-xs text-neutral-400">
					Another device wants to verify with you.
				</p>
				<div class="flex justify-end gap-2">
					<button
						type="button"
						onClick={handleDecline}
						class="rounded px-3 py-1.5 text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
					>
						Decline
					</button>
					<button
						type="button"
						onClick={handleAccept}
						class="rounded bg-green-700 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-green-600"
					>
						Accept
					</button>
				</div>
			</div>
		</Show>
	);
};

export default IncomingVerificationToast;
