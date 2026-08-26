import type { MatrixClient } from "matrix-js-sdk";
import {
	VerificationPhase,
	VerificationRequestEvent,
	VerifierEvent,
} from "matrix-js-sdk/lib/crypto-api";
import type {
	EmojiMapping,
	ShowQrCodeCallbacks,
	ShowSasCallbacks,
	VerificationRequest,
	Verifier,
} from "matrix-js-sdk/lib/crypto-api/verification";
import { VerificationMethod } from "matrix-js-sdk/lib/types";
import { type Accessor, createSignal, onCleanup } from "solid-js";
import { userFacingErrorMessage } from "../../../lib/errorMessage";

export type VerificationState =
	| "idle"
	| "requested"
	| "ready"
	| "qr-showing"
	| "qr-reciprocate"
	| "qr-confirmed"
	| "sas-showing"
	| "sas-confirmed"
	| "done"
	| "cancelled"
	| "error";

export interface VerificationHandle {
	state: Accessor<VerificationState>;
	emoji: Accessor<EmojiMapping[] | undefined>;
	/**
	 * Raw QR bytes to display while `state()` is `"qr-showing"`, from
	 * `VerificationRequest.generateQRCode()`.
	 */
	qrBytes: Accessor<Uint8ClampedArray | undefined>;
	error: Accessor<string>;
	isSelfVerification: Accessor<boolean>;
	otherUserId: Accessor<string>;

	/** Start self-verification (verify this device from another) */
	requestSelfVerification: () => Promise<void>;
	/** Start verification of a specific device */
	requestDeviceVerification: (deviceId: string) => Promise<void>;
	/** Accept an incoming verification request */
	acceptIncoming: (request: VerificationRequest) => void;
	/** Abandon the displayed QR code and fall back to emoji comparison */
	startSas: () => Promise<void>;
	/** Confirm the SAS emoji match */
	confirmSas: () => Promise<void>;
	/** Reject / indicate SAS mismatch */
	rejectSas: () => void;
	/** Confirm that the other side's scan of our QR code succeeded */
	confirmQr: () => void;
	/** Reject the other side's scan of our QR code */
	rejectQr: () => void;
	/** Cancel the entire verification */
	cancel: () => void;
	/** Reset to idle state */
	reset: () => void;
}

/**
 * Hook managing the full verification lifecycle. Tracks a single active
 * VerificationRequest and its Verifier, exposing reactive signals for the UI.
 *
 * Two methods are supported, matching what the client advertises (see
 * `SUPPORTED_VERIFICATION_METHODS` in `client/client.tsx`): we show a QR code
 * for the other device to scan (`m.qr_code.show.v1` plus `m.reciprocate.v1`),
 * and we compare emoji (`m.sas.v1`). We never scan, so SAS is the fallback
 * whenever a QR code cannot be produced - which the SDK signals by returning
 * `undefined` from `generateQRCode()` (wrong phase, other side cannot scan,
 * or our cross-signing keys are not available locally).
 */
export function useVerification(client: MatrixClient): VerificationHandle {
	const [state, setState] = createSignal<VerificationState>("idle");
	const [emoji, setEmoji] = createSignal<EmojiMapping[] | undefined>(undefined);
	const [qrBytes, setQrBytes] = createSignal<Uint8ClampedArray | undefined>(
		undefined,
	);
	const [error, setError] = createSignal("");
	const [isSelfVerification, setIsSelfVerification] = createSignal(false);
	const [otherUserId, setOtherUserId] = createSignal("");

	let activeRequest: VerificationRequest | null = null;
	let activeVerifier: Verifier | null = null;
	let sasCallbacks: ShowSasCallbacks | null = null;
	let qrCallbacks: ShowQrCodeCallbacks | null = null;
	// The Ready phase re-fires on every subsequent change event (generating a
	// QR code is itself one), so the method choice runs at most once per
	// request rather than restarting on each.
	let readyHandled = false;
	// Incremented on each new request attempt; checked after async to discard stale results
	let requestGeneration = 0;

	const detachVerifier = (): void => {
		// Remove only our listeners to prevent re-entrance from cancel events
		if (activeVerifier) {
			activeVerifier.off(VerifierEvent.ShowSas, onShowSas);
			activeVerifier.off(VerifierEvent.ShowReciprocateQr, onShowReciprocateQr);
			activeVerifier.off(VerifierEvent.Cancel, onVerifierCancel);
			activeVerifier = null;
		}
		sasCallbacks = null;
		qrCallbacks = null;
	};

	const cleanupRequest = (): void => {
		detachVerifier();
		if (activeRequest) {
			activeRequest.off(VerificationRequestEvent.Change, onRequestChange);
			if (activeRequest.pending) {
				activeRequest.cancel().catch(() => {});
			}
			activeRequest = null;
		}
		readyHandled = false;
	};

	const onShowSas = (sas: ShowSasCallbacks): void => {
		sasCallbacks = sas;
		setQrBytes(undefined);
		if (sas.sas.emoji) {
			setEmoji(sas.sas.emoji);
			setState("sas-showing");
		} else {
			// Emoji SAS not negotiated (decimal-only). Detach listeners
			// first so the cancel event can't overwrite our error state.
			cleanupRequest();
			setError("Emoji verification not supported by the other device");
			setState("error");
			sas.cancel();
		}
	};

	const onShowReciprocateQr = (qr: ShowQrCodeCallbacks): void => {
		qrCallbacks = qr;
		setState("qr-reciprocate");
	};

	const onVerifierCancel = (): void => {
		setState("cancelled");
		cleanupRequest();
	};

	/**
	 * Take whatever the active verifier is already holding.
	 *
	 * The SDK's `ShowSas` / `ShowReciprocateQr` events are not a reliable
	 * one-shot: a rust verifier only emits them from inside `verify()`, and
	 * only if its callbacks happen to be populated by then. The verifier and
	 * the request register separate rust change callbacks, so the request's
	 * can land first - `verify()` then emits nothing and no later event ever
	 * re-emits it, which would strand the user on a code the other side has
	 * already scanned. Reading the getters on every change closes that gap;
	 * the events still arrive first in the usual ordering, and the `already
	 * have it` checks keep this idempotent either way.
	 */
	const drainVerifierCallbacks = (): void => {
		const verifier = activeVerifier;
		if (!verifier) return;
		if (!qrCallbacks) {
			const qr = verifier.getReciprocateQrCodeCallbacks();
			if (qr) onShowReciprocateQr(qr);
		}
		// Re-read: onShowReciprocateQr cannot detach us, but onShowSas can.
		if (activeVerifier === verifier && !sasCallbacks) {
			const sas = verifier.getShowSasCallbacks();
			if (sas) onShowSas(sas);
		}
	};

	/**
	 * Attach to a verifier and drive it. Covers both the verifier we create
	 * ourselves for SAS and the one the SDK creates when the other side sends
	 * an `m.key.verification.start` - for `m.reciprocate.v1` after scanning
	 * our QR code, or for `m.sas.v1` if it picked emoji while we were showing
	 * one.
	 */
	const bindVerifier = (verifier: Verifier): void => {
		if (activeVerifier === verifier) return;
		if (activeVerifier) {
			// A verifier is already in flight and this is a different one, so
			// the SDK replaced it (QR gave way to SAS). Drop our listeners on
			// the old one before taking the new, or its events keep driving
			// the UI.
			detachVerifier();
		}
		activeVerifier = verifier;

		// A method has started, so the code is spent. Leave `qr-showing` in
		// the same breath as clearing the bytes: the QR view has no empty
		// state, so a gap here would blank a 256px box under a heading still
		// telling the user to scan it. This also makes the state the single
		// authority on whether a method has started - `startSas` relies on it.
		setQrBytes(undefined);
		if (state() === "qr-showing") setState("ready");

		verifier.on(VerifierEvent.ShowSas, onShowSas);
		verifier.on(VerifierEvent.ShowReciprocateQr, onShowReciprocateQr);
		verifier.on(VerifierEvent.Cancel, onVerifierCancel);

		const gen = requestGeneration;
		const bound = verifier;
		const verifying = verifier.verify();
		drainVerifierCallbacks();
		verifying.catch((e) => {
			// A verifier we dropped is not ours to fail on. The SDK cancels
			// the abandoned verification when it swaps QR for SAS, which
			// rejects this promise while the replacement is running happily -
			// without the identity check that rejection would tear down the
			// live flow. `requestGeneration` cannot catch it: the request is
			// the same one.
			if (gen !== requestGeneration || activeVerifier !== bound) return;
			const s = state();
			if (
				s !== "cancelled" &&
				s !== "done" &&
				s !== "sas-confirmed" &&
				s !== "qr-confirmed" &&
				s !== "error"
			) {
				setError(userFacingErrorMessage(e, "Verification failed"));
				setState("error");
				cleanupRequest();
			}
		});
	};

	const startSasVerification = async (): Promise<void> => {
		if (!activeRequest || activeVerifier) return;

		const gen = requestGeneration;
		const request = activeRequest;
		try {
			const verifier = await request.startVerification(VerificationMethod.Sas);
			// Abort if cancelled/reset during the await
			if (gen !== requestGeneration || activeRequest !== request) {
				verifier.cancel(new Error("Superseded"));
				return;
			}
			bindVerifier(verifier);
		} catch (e) {
			if (gen !== requestGeneration || activeRequest !== request) return;
			setError(userFacingErrorMessage(e, "Failed to start verification"));
			setState("error");
			cleanupRequest();
		}
	};

	/**
	 * Both sides are ready: pick a method. Show a QR code when the other side
	 * can scan one and the SDK can build it, otherwise go straight to emoji.
	 */
	const startReadyPhase = async (): Promise<void> => {
		if (!activeRequest || activeVerifier) return;

		const gen = requestGeneration;
		const request = activeRequest;

		if (request.otherPartySupportsMethod(VerificationMethod.ScanQrCode)) {
			try {
				const bytes = await request.generateQRCode();
				// The other side may have started a method of its own during
				// the await, in which case that verifier owns the UI now.
				if (gen !== requestGeneration || activeRequest !== request) return;
				if (activeVerifier) return;
				if (bytes && bytes.length > 0) {
					setQrBytes(bytes);
					setState("qr-showing");
					return;
				}
			} catch (e) {
				// Thrown whenever the SDK cannot build a code, most often
				// because the other device is not yet known to us. Not
				// user-facing: emoji covers the same ground.
				console.warn("QR verification unavailable, using emoji:", e);
				if (gen !== requestGeneration || activeRequest !== request) return;
			}
		}

		await startSasVerification();
	};

	const onRequestChange = (): void => {
		if (!activeRequest) return;

		const phase = activeRequest.phase;

		switch (phase) {
			case VerificationPhase.Ready:
				if (readyHandled) break;
				readyHandled = true;
				setState("ready");
				startReadyPhase();
				break;
			case VerificationPhase.Started: {
				// The other side chose a method: either it scanned our QR code
				// (reciprocate) or it started emoji comparison. Either way the
				// SDK already has a verifier; we only have to drive it.
				const verifier = activeRequest.verifier;
				if (verifier) bindVerifier(verifier);
				// Started re-fires as the verifier progresses; that is where
				// callbacks the initial bind was too early to see turn up.
				drainVerifierCallbacks();
				break;
			}
			case VerificationPhase.Cancelled:
				setState("cancelled");
				cleanupRequest();
				break;
			case VerificationPhase.Done:
				setState("done");
				cleanupRequest();
				break;
		}
	};

	const bindRequest = (request: VerificationRequest): void => {
		cleanupRequest();
		activeRequest = request;
		setIsSelfVerification(request.isSelfVerification);
		setOtherUserId(request.otherUserId);
		setEmoji(undefined);
		setQrBytes(undefined);
		setError("");

		request.on(VerificationRequestEvent.Change, onRequestChange);

		if (request.phase === VerificationPhase.Ready) {
			readyHandled = true;
			setState("ready");
			startReadyPhase();
		} else {
			setState("requested");
		}
	};

	const requestSelfVerification = async (): Promise<void> => {
		const crypto = client.getCrypto();
		if (!crypto) {
			setError("Encryption is not available");
			setState("error");
			return;
		}

		const gen = ++requestGeneration;
		cleanupRequest();
		try {
			setState("requested");
			const request = await crypto.requestOwnUserVerification();
			if (gen !== requestGeneration) {
				if (request.pending) request.cancel().catch(() => {});
				return;
			}
			bindRequest(request);
		} catch (e) {
			if (gen !== requestGeneration) return;
			setError(userFacingErrorMessage(e, "Failed to request verification"));
			setState("error");
		}
	};

	const requestDeviceVerification = async (deviceId: string): Promise<void> => {
		const crypto = client.getCrypto();
		if (!crypto) {
			setError("Encryption is not available");
			setState("error");
			return;
		}

		const userId = client.getUserId();
		if (!userId) {
			setError("Unable to determine user ID");
			setState("error");
			return;
		}

		const gen = ++requestGeneration;
		cleanupRequest();
		try {
			setState("requested");
			const request = await crypto.requestDeviceVerification(userId, deviceId);
			if (gen !== requestGeneration) {
				if (request.pending) request.cancel().catch(() => {});
				return;
			}
			bindRequest(request);
		} catch (e) {
			if (gen !== requestGeneration) return;
			setError(userFacingErrorMessage(e, "Failed to request verification"));
			setState("error");
		}
	};

	const acceptIncoming = (request: VerificationRequest): void => {
		const gen = ++requestGeneration;
		bindRequest(request);
		request.accept().catch((e) => {
			if (gen !== requestGeneration) return;
			const s = state();
			if (s === "cancelled" || s === "done" || s === "error") return;
			setError(userFacingErrorMessage(e, "Failed to accept verification"));
			setState("error");
			cleanupRequest();
		});
	};

	const startSas = async (): Promise<void> => {
		// `qr-showing` is both the only view that offers this and, per
		// `bindVerifier`, proof that no method has started yet - so this one
		// check also guarantees `startSasVerification` will not no-op and
		// leave the spinner up forever.
		if (state() !== "qr-showing") return;
		setQrBytes(undefined);
		setState("ready");
		await startSasVerification();
	};

	const confirmSas = async (): Promise<void> => {
		if (!sasCallbacks) return;
		const gen = requestGeneration;
		setState("sas-confirmed");
		try {
			await sasCallbacks.confirm();
		} catch (e) {
			if (gen !== requestGeneration) return;
			setError(userFacingErrorMessage(e, "Failed to confirm verification"));
			setState("error");
			cleanupRequest();
		}
	};

	const rejectSas = (): void => {
		if (sasCallbacks) {
			sasCallbacks.mismatch();
		}
		setState("cancelled");
		cleanupRequest();
	};

	const confirmQr = (): void => {
		if (!qrCallbacks) return;
		setState("qr-confirmed");
		qrCallbacks.confirm();
	};

	const rejectQr = (): void => {
		if (qrCallbacks) {
			qrCallbacks.cancel();
		}
		setState("cancelled");
		cleanupRequest();
	};

	const cancel = (): void => {
		requestGeneration++;
		setState("cancelled");
		cleanupRequest();
	};

	const reset = (): void => {
		requestGeneration++;
		cleanupRequest();
		setState("idle");
		setEmoji(undefined);
		setQrBytes(undefined);
		setError("");
		setIsSelfVerification(false);
		setOtherUserId("");
	};

	onCleanup(() => {
		cleanupRequest();
	});

	return {
		state,
		emoji,
		qrBytes,
		error,
		isSelfVerification,
		otherUserId,
		requestSelfVerification,
		requestDeviceVerification,
		acceptIncoming,
		startSas,
		confirmSas,
		rejectSas,
		confirmQr,
		rejectQr,
		cancel,
		reset,
	};
}
