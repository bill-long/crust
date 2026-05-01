import type { MatrixClient } from "matrix-js-sdk";
import {
	VerificationPhase,
	VerificationRequestEvent,
	VerifierEvent,
} from "matrix-js-sdk/lib/crypto-api";
import type {
	EmojiMapping,
	ShowSasCallbacks,
	VerificationRequest,
	Verifier,
} from "matrix-js-sdk/lib/crypto-api/verification";
import { type Accessor, createSignal, onCleanup } from "solid-js";

export type VerificationState =
	| "idle"
	| "requested"
	| "ready"
	| "sas-showing"
	| "sas-confirmed"
	| "done"
	| "cancelled"
	| "error";

export interface VerificationHandle {
	state: Accessor<VerificationState>;
	emoji: Accessor<EmojiMapping[] | undefined>;
	error: Accessor<string>;
	isSelfVerification: Accessor<boolean>;
	otherUserId: Accessor<string>;

	/** Start self-verification (verify this device from another) */
	requestSelfVerification: () => Promise<void>;
	/** Start verification of a specific device */
	requestDeviceVerification: (deviceId: string) => Promise<void>;
	/** Accept an incoming verification request */
	acceptIncoming: (request: VerificationRequest) => void;
	/** Confirm the SAS emoji match */
	confirmSas: () => Promise<void>;
	/** Reject / indicate SAS mismatch */
	rejectSas: () => void;
	/** Cancel the entire verification */
	cancel: () => void;
	/** Reset to idle state */
	reset: () => void;
}

/**
 * Hook managing the full SAS verification lifecycle. Tracks a single
 * active VerificationRequest and its Verifier, exposing reactive
 * signals for the UI.
 */
export function useVerification(client: MatrixClient): VerificationHandle {
	const [state, setState] = createSignal<VerificationState>("idle");
	const [emoji, setEmoji] = createSignal<EmojiMapping[] | undefined>(undefined);
	const [error, setError] = createSignal("");
	const [isSelfVerification, setIsSelfVerification] = createSignal(false);
	const [otherUserId, setOtherUserId] = createSignal("");

	let activeRequest: VerificationRequest | null = null;
	let activeVerifier: Verifier | null = null;
	let sasCallbacks: ShowSasCallbacks | null = null;
	// Incremented on each new request attempt; checked after async to discard stale results
	let requestGeneration = 0;

	const cleanupRequest = (): void => {
		// Remove listeners first to prevent re-entrance from cancel events
		if (activeVerifier) {
			activeVerifier.removeAllListeners();
			activeVerifier = null;
		}
		if (activeRequest) {
			activeRequest.removeAllListeners();
			if (activeRequest.pending) {
				activeRequest.cancel().catch(() => {});
			}
			activeRequest = null;
		}
		sasCallbacks = null;
	};

	const onShowSas = (sas: ShowSasCallbacks): void => {
		sasCallbacks = sas;
		if (sas.sas.emoji) {
			setEmoji(sas.sas.emoji);
			setState("sas-showing");
		} else {
			// Emoji SAS not negotiated (decimal-only) — cancel since
			// our UI only supports emoji comparison
			sas.cancel();
			setError("Emoji verification not supported by the other device");
			setState("error");
			cleanupRequest();
		}
	};

	const onVerifierCancel = (): void => {
		setState("cancelled");
		cleanupRequest();
	};

	const startSasVerification = async (): Promise<void> => {
		if (!activeRequest || activeVerifier) return;

		try {
			const verifier = await activeRequest.startVerification("m.sas.v1");
			activeVerifier = verifier;

			verifier.on(VerifierEvent.ShowSas, onShowSas);
			verifier.on(VerifierEvent.Cancel, onVerifierCancel);

			verifier.verify().catch((e) => {
				const s = state();
				if (s !== "cancelled" && s !== "done" && s !== "sas-confirmed") {
					setError(e instanceof Error ? e.message : "Verification failed");
					setState("error");
					cleanupRequest();
				}
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to start verification");
			setState("error");
			cleanupRequest();
		}
	};

	const onRequestChange = (): void => {
		if (!activeRequest) return;

		const phase = activeRequest.phase;

		switch (phase) {
			case VerificationPhase.Ready:
				setState("ready");
				startSasVerification();
				break;
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
		setError("");

		request.on(VerificationRequestEvent.Change, onRequestChange);

		if (request.phase === VerificationPhase.Ready) {
			setState("ready");
			startSasVerification();
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
		try {
			setState("requested");
			const request = await crypto.requestOwnUserVerification();
			if (gen !== requestGeneration) return;
			bindRequest(request);
		} catch (e) {
			if (gen !== requestGeneration) return;
			setError(
				e instanceof Error ? e.message : "Failed to request verification",
			);
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
		try {
			setState("requested");
			const request = await crypto.requestDeviceVerification(userId, deviceId);
			if (gen !== requestGeneration) return;
			bindRequest(request);
		} catch (e) {
			if (gen !== requestGeneration) return;
			setError(
				e instanceof Error ? e.message : "Failed to request verification",
			);
			setState("error");
		}
	};

	const acceptIncoming = (request: VerificationRequest): void => {
		bindRequest(request);
		request.accept().catch((e) => {
			setError(
				e instanceof Error ? e.message : "Failed to accept verification",
			);
			setState("error");
			cleanupRequest();
		});
	};

	const confirmSas = async (): Promise<void> => {
		if (!sasCallbacks) return;
		setState("sas-confirmed");
		try {
			await sasCallbacks.confirm();
		} catch (e) {
			setError(
				e instanceof Error ? e.message : "Failed to confirm verification",
			);
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
		error,
		isSelfVerification,
		otherUserId,
		requestSelfVerification,
		requestDeviceVerification,
		acceptIncoming,
		confirmSas,
		rejectSas,
		cancel,
		reset,
	};
}
